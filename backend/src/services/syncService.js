import db from '../config/db.js';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { logger } from '../utils/logger.js';
import { handleStatusMessage } from './mqttService.js';

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
  const [localRows] = await db.query(
    'SELECT status, target, ideal_cycle_time, active_part_name, assigned_operator FROM machines WHERE id = ?',
    [machineId]
  );
  if (localRows.length === 0) return;
  const local = localRows[0];

  const remotePart = remote.active_part_name || 'Unassigned';
  const remoteOperator = remote.assigned_operator || 'Unassigned';
  const differs = remote.target !== local.target
    || remote.ideal_cycle_time !== local.ideal_cycle_time
    || remotePart !== local.active_part_name
    || remoteOperator !== local.assigned_operator;

  if (!differs) return;

  await db.query(
    'UPDATE machines SET target = ?, ideal_cycle_time = ?, active_part_name = ?, assigned_operator = ? WHERE id = ?',
    [remote.target, remote.ideal_cycle_time, remotePart, remoteOperator, machineId]
  );
  logger.info(`🔄 Sync: Pulled updated plan for machine ${machineId} from cloud (target=${remote.target}, cycle=${remote.ideal_cycle_time}s)`);

  // Recompute OEE and broadcast the change to this gateway's own locally-connected clients
  // (the operator terminal), mirroring shiftPlans.js's applyPlanToMachine on the cloud side.
  await handleStatusMessage(machineId, local.status);
}

/**
 * Performs data synchronization
 */
async function synchronizeData(cloudUrl) {
  // 1. Fetch unsynced pulses (batch of 50)
  const [pulses] = await db.query(
    'SELECT id, machine_id, timestamp, cycle_time, is_good FROM pulses WHERE synced = 0 ORDER BY id ASC LIMIT 50'
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
