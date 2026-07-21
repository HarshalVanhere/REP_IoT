import db from '../config/db.js';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { logger } from '../utils/logger.js';
import { handleStatusMessage } from './mqttService.js';
import { resetProductionCounters } from './productionRecordService.js';
import { sendSerialCommand } from './serialService.js';
import { withMachineLock } from '../utils/machineLock.js';

let syncIntervalId = null;
let isSyncing = false; // Prevent overlapping runs

/**
 * Simple HTTP/HTTPS client helper for maximum compatibility across Node.js versions
 */
function request(urlStr, options, postData) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlStr);
      const client = url.protocol === 'https:' ? https : http;
      
      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      };

      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: () => Promise.resolve(data),
            json: () => {
              try {
                return Promise.resolve(JSON.parse(data));
              } catch (e) {
                return Promise.reject(new Error(`Failed to parse JSON: ${data}`));
              }
            }
          });
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      if (postData) {
        req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Starts the background sync service if configured as an Edge Gateway
 */
export function startSyncService() {
  const isEdgeGateway = process.env.IS_EDGE_GATEWAY === 'true';
  const cloudUrl = process.env.CLOUD_BACKEND_URL;

  if (!isEdgeGateway) {
    logger.info('☁️  Running in Cloud Mode (Local Sync Client Disabled)');
    return;
  }

  if (!cloudUrl) {
    logger.error('❌ Sync service error: CLOUD_BACKEND_URL is not set!');
    return;
  }

  logger.info(`📠 Running in Edge Gateway Mode. Syncing to: ${cloudUrl}`);

  // Run synchronization check every 5 seconds
  syncIntervalId = setInterval(async () => {
    if (isSyncing) return;
    isSyncing = true;

    try {
      await synchronizeData(cloudUrl);
    } catch (err) {
      // Log errors quietly to avoid bloating console in offline mode
      logger.warn(`🔄 Sync offline: Cloud unavailable (${err.message})`);
    }

    try {
      await pullMachineConfig(cloudUrl);
    } catch (err) {
      logger.warn(`🔄 Sync: Failed to pull machine config (${err.message})`);
    } finally {
      isSyncing = false;
    }
  }, 5000);
}

/**
 * Pulls this gateway's own machine row (target, cycle time, part, operator) down from the
 * cloud and applies it to the local DB, then re-broadcasts locally so the operator terminal
 * picks it up - the counterpart to synchronizeData()'s upload above.
 */
async function pullMachineConfig(cloudUrl) {
  const machineId = process.env.GATEWAY_MACHINE_ID;
  if (!machineId) return;

  const headers = {};
  if (process.env.SYNC_API_KEY) {
    headers['x-sync-key'] = process.env.SYNC_API_KEY;
  }

  const endpoint = `${cloudUrl.replace(/\/$/, '')}/api/sync/machine-config/${machineId}`;
  const res = await request(endpoint, { method: 'GET', headers });
  if (!res.ok) {
    if (res.status !== 404) {
      logger.warn(`🔄 Sync: Failed to pull machine config (HTTP ${res.status})`);
    }
    return;
  }

  const remote = await res.json();

  // Serialized against /stop, /resume, and the watchdog's stale-pulse auto-stop so a pull can
  // never interleave with - or get immediately undone by - an operator action or another sync
  // tick for the same machine. This is also what makes this function the Edge Gateway's single
  // authority on "is there a valid schedule": the local watchdog's own scheduler never runs
  // here (see watchdogService.js) specifically so this is the only code path that can decide it.
  await withMachineLock(machineId, async () => {
    const [localRows] = await db.query(
      'SELECT status, target, ideal_cycle_time, active_part_name, assigned_operator, active_schedule_id, last_manual_reset_at FROM machines WHERE id = ?',
      [machineId]
    );
    if (localRows.length === 0) return;
    const local = localRows[0];

    // A manual reset triggered from the cloud dashboard only ever touches the cloud's own
    // mirror of the count - this gateway is what actually increments production_count live off
    // real pulses, so the reset has to be explicitly mirrored down here rather than picked up
    // via the target/part/operator diff below.
    const remoteResetAt = remote.last_manual_reset_at ? new Date(remote.last_manual_reset_at).getTime() : 0;
    const localResetAt = local.last_manual_reset_at ? new Date(local.last_manual_reset_at).getTime() : 0;
    if (remoteResetAt > localResetAt) {
      await resetProductionCounters(machineId, 'manual_reset', null, { changeTrigger: 'cloud_sync' });
      // remote.last_manual_reset_at arrives as a JSON-serialized ISO string (e.g.
      // '2026-07-21T04:57:57.000Z') - mysql2 passes raw strings through as literal SQL text
      // rather than reformatting them, and MySQL's strict mode rejects the 'T'/'Z' ISO format
      // for a DATETIME/TIMESTAMP column. Wrapping in `new Date()` lets mysql2 serialize it
      // properly, the same way it already does for every other Date value in this codebase.
      await db.query('UPDATE machines SET last_manual_reset_at = ? WHERE id = ?', [new Date(remote.last_manual_reset_at), machineId]);
      logger.info(`🔄 Sync: Mirrored a cloud-triggered manual reset for machine ${machineId}`);
    }

    // No active schedule on the cloud (the actual PPC authority) - enforce "no production
    // without a valid schedule" exactly like blockMachineWithoutSchedule does on the
    // non-edge/scheduler side, but sourced from the cloud's resolved active_schedule_id instead
    // of a local part_schedules table this gateway never populates. Force-stopping here (not
    // just clearing the display fields) is what actually de-energizes the interlock relay if a
    // shift/schedule ended while this machine was mid-run.
    if (!remote.active_schedule_id) {
      const hadSomethingToClear = local.active_schedule_id || (local.active_part_name && local.active_part_name !== 'Unassigned');
      if (hadSomethingToClear || local.status === 'Running') {
        await db.query(
          "UPDATE machines SET active_part_name = 'Unassigned', assigned_operator = 'Unassigned', active_schedule_id = NULL WHERE id = ?",
          [machineId]
        );
        if (local.status === 'Running') {
          try {
            await sendSerialCommand(machineId, 'stop');
          } catch (serialErr) {
            logger.warn(`🔄 Sync: Failed to send interlock stop command while blocking machine ${machineId} (no cloud schedule): ${serialErr.message}`);
          }
          await handleStatusMessage(machineId, 'Stopped');
          logger.info(`🔄 Sync: Machine ${machineId} has no active schedule on the cloud - force-stopped and blocked.`);
        } else {
          await handleStatusMessage(machineId, local.status);
          logger.info(`🔄 Sync: Machine ${machineId} has no active schedule on the cloud - blocked.`);
        }
      }
      return;
    }

    const remotePart = remote.active_part_name || 'Unassigned';
    const remoteOperator = remote.assigned_operator || 'Unassigned';
    const differs = remote.target !== local.target
      || remote.ideal_cycle_time !== local.ideal_cycle_time
      || remotePart !== local.active_part_name
      || remoteOperator !== local.assigned_operator
      || remote.active_schedule_id !== local.active_schedule_id;

    if (!differs) return;

    // A part change pulled down from the cloud closes out the previous part's tally as its
    // own permanent record before the new part starts counting from 0 on this gateway. The
    // cloud's part_schedules id rides along as-is - this gateway has no schedule table of its
    // own, it only ever mirrors whichever entry the cloud has already resolved as active.
    if (remotePart !== local.active_part_name) {
      await resetProductionCounters(machineId, 'part_change', null, {
        scheduleId: local.active_schedule_id || null,
        nextPartName: remotePart,
        changeTrigger: 'cloud_sync'
      });
    }

    await db.query(
      'UPDATE machines SET target = ?, ideal_cycle_time = ?, active_part_name = ?, assigned_operator = ?, active_schedule_id = ? WHERE id = ?',
      [remote.target, remote.ideal_cycle_time, remotePart, remoteOperator, remote.active_schedule_id || null, machineId]
    );
    logger.info(`🔄 Sync: Pulled updated plan for machine ${machineId} from cloud (target=${remote.target}, cycle=${remote.ideal_cycle_time}s)`);

    // Recompute OEE and broadcast the change to this gateway's own locally-connected clients
    // (the operator terminal), mirroring shiftPlans.js's applyPlanToMachine on the cloud side.
    await handleStatusMessage(machineId, local.status);
  });
}

/**
 * Performs data synchronization
 */
async function synchronizeData(cloudUrl) {
  // 1. Fetch unsynced pulses (batch of 50)
  const [pulses] = await db.query(
    'SELECT id, machine_id, timestamp, cycle_time, is_good, part_schedule_id FROM pulses WHERE synced = 0 ORDER BY id ASC LIMIT 50'
  );

  // 2. Fetch unsynced status logs (batch of 50)
  const [statusLogs] = await db.query(
    'SELECT id, machine_id, status, start_time, end_time, downtime_reason, operator_id, part_name FROM status_logs WHERE synced = 0 ORDER BY id ASC LIMIT 50'
  );

  if (pulses.length === 0 && statusLogs.length === 0) {
    return; // Nothing to sync
  }

  logger.info(`🔄 Sync: Found ${pulses.length} pulses and ${statusLogs.length} status logs to upload...`);

  // 3. Post to the cloud backend sync endpoint
  const syncEndpoint = `${cloudUrl.replace(/\/$/, '')}/api/sync/data`;
  
  const payload = { pulses, statusLogs };
  const headers = {};
  if (process.env.SYNC_API_KEY) {
    headers['x-sync-key'] = process.env.SYNC_API_KEY;
  }
  const res = await request(syncEndpoint, { method: 'POST', headers }, payload);

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloud server returned ${res.status}: ${errorText}`);
  }

  const result = await res.json();
  logger.info(`✅ Sync: Uploaded batch. Cloud response:`, result);

  // 4. Mark uploaded data as synced in local DB
  if (pulses.length > 0) {
    const pulseIds = pulses.map(p => p.id);
    await db.query('UPDATE pulses SET synced = 1 WHERE id IN (?)', [pulseIds]);
  }

  if (statusLogs.length > 0) {
    const logIds = statusLogs.map(l => l.id);
    await db.query('UPDATE status_logs SET synced = 1 WHERE id IN (?)', [logIds]);
  }
}
