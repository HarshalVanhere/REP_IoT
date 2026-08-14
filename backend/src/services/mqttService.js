import Aedes from 'aedes';
import net from 'net';
import db from '../config/db.js';
import { calculateOEE } from './oeeCalculator.js';
import { logger } from '../utils/logger.js';
import { withMachineLock } from '../utils/machineLock.js';

let aedesInstance = null;
let server = null;
let wsBroadcastCallback = null; // Callback to broadcast updates via WebSocket

/**
 * Initializes and starts the embedded MQTT broker
 * @param {Function} broadcastCallback - Function to call for WebSocket broadcasting
 */
export function startMQTTBroker(broadcastCallback) {
  wsBroadcastCallback = broadcastCallback;
  
  aedesInstance = new Aedes();

  // Require credentials for any client connecting to the broker, unless explicitly
  // left unconfigured for local development (logs a loud warning either way).
  const mqttUsername = process.env.MQTT_USERNAME;
  const mqttPassword = process.env.MQTT_PASSWORD;

  if (mqttUsername && mqttPassword) {
    aedesInstance.authenticate = (client, username, password, callback) => {
      const providedPassword = password ? password.toString() : '';
      const authorized = username === mqttUsername && providedPassword === mqttPassword;
      if (!authorized) {
        logger.warn(`MQTT: Rejected unauthenticated client "${client.id}" (username: ${username || 'none'})`);
      }
      callback(null, authorized);
    };
  } else {
    logger.warn('MQTT_USERNAME/MQTT_PASSWORD are not set - the embedded MQTT broker is accepting UNAUTHENTICATED publishes. Set them before deploying to a real network.');
  }

  const port = parseInt(process.env.MQTT_PORT || '1883');
  server = net.createServer(aedesInstance.handle);
  
  server.listen(port, () => {
    logger.info(`🚀 Embedded MQTT Broker listening on port ${port}`);
  });

  server.on('error', (err) => {
    logger.error('❌ MQTT Broker server error:', err.message);
  });

  // Handle incoming publications
  aedesInstance.on('publish', async (packet, client) => {
    const topic = packet.topic;
    
    // Ignore internal system topic publishes
    if (topic.startsWith('$')) return;
    
    // Check if the topic matches our CNC pattern: cnc/{machineId}/{type}
    const topicParts = topic.split('/');
    if (topicParts.length === 3 && topicParts[0] === 'cnc') {
      const machineId = topicParts[1];
      const messageType = topicParts[2];
      const payloadStr = packet.payload.toString();
      
      try {
        let payload = {};
        try {
          payload = JSON.parse(payloadStr);
        } catch {
          payload = { value: payloadStr };
        }

        // Locked per-machine so a device publishing pulse/status messages back-to-back (or two
        // machines' messages arriving interleaved) can never race the other status_logs writers
        // (watchdog self-heal, /stop, /resume, sync) for the same machine - matches every other
        // entry point into handleStatusMessage/handlePulseMessage elsewhere in this codebase.
        // handleHeartbeatMessage is deliberately NOT included here - it already takes this same
        // per-machine lock internally, and nesting two withMachineLock calls for the same
        // machineId would deadlock (the inner call would wait on the outer's own in-flight turn).
        if (messageType === 'pulse') {
          await withMachineLock(machineId, () => handlePulseMessage(machineId, payload));
        } else if (messageType === 'status') {
          await withMachineLock(machineId, () => handleStatusMessage(machineId, payload.status || payload.value));
        } else if (messageType === 'heartbeat') {
          await handleHeartbeatMessage(machineId);
        }
      } catch (err) {
        logger.error(`Error processing MQTT topic ${topic}:`, err.message);
      }
    }
  });
}

/**
 * Internal helper to publish MQTT messages
 */
export function publishMQTT(topic, payload) {
  if (!aedesInstance) return;
  const message = {
    topic,
    payload: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    qos: 0,
    retain: false
  };
  aedesInstance.publish(message, (err) => {
    if (err) logger.error('Error publishing MQTT internally:', err);
  });
}

/**
 * Handles pulse messages from machines
 */
export async function handlePulseMessage(machineId, payload) {
  // Self-locking (see handleStatusMessage) - a pulse can self-heal status to 'Running' below,
  // which must never interleave with a concurrent status transition for the same machine.
  return withMachineLock(machineId, () => handlePulseMessageLocked(machineId, payload));
}

async function handlePulseMessageLocked(machineId, payload) {
  const cycleTime = parseFloat(payload.cycleTime || 10);
  const isGood = payload.isGood !== undefined ? payload.isGood : true;
  const timestamp = new Date();
  timestamp.setMilliseconds(0);

  // 1. Double check if machine exists, if not create/verify it
  const [machines] = await db.query('SELECT * FROM machines WHERE id = ?', [machineId]);
  if (machines.length === 0) {
    logger.warn(`Machine ${machineId} does not exist in db. Skipping pulse.`);
    return;
  }

  // While the machine is deliberately Stopped, ignore pulses entirely - no row in `pulses`,
  // no count increment. Status is only ever changed by an explicit status message
  // (see handleStatusMessage), never inferred from a pulse arriving.
  if (machines[0].status === 'Stopped') {
    logger.info(`Machine ${machineId} is Stopped - ignoring pulse (not counted).`);
    return;
  }

  // CRITICAL FIX: a pulse can only ever originate from the physically wired machine actively
  // communicating - it is direct, unambiguous proof of connectivity. If the watchdog previously
  // force-marked this machine "Not Connected" (stale-pulse heartbeat timeout, see
  // watchdogService.js) and it then resumes producing, nothing else in the system ever notices
  // and self-corrects: status is only ever changed by an explicit status message, never inferred
  // from a pulse. Without this, the dashboard is stuck showing "Not Connected" indefinitely -
  // even while production_count keeps climbing underneath - until something incidentally
  // triggers a fresh status message (e.g. a full service restart's serial boot-sync happening to
  // round-trip a command). Routed through the same handleStatusMessage() transition path
  // everything else uses (closes the stale status log, opens a fresh one, broadcasts the
  // change) rather than duplicating that logic here.
  if (machines[0].status === 'Not Connected') {
    logger.info(`🔌 Machine ${machineId}: pulse received while marked Not Connected - self-healing to Running.`);
    await handleStatusMessage(machineId, 'Running');
    machines[0].status = 'Running';
  }

  // 2. Insert pulse log into database, stamped with whichever scheduled part is currently
  // active (if any) so per-part production can be attributed correctly even when execution
  // has diverged from the plan (manual overrides, forced end-time cutovers).
  await db.query(
    'INSERT INTO pulses (machine_id, timestamp, cycle_time, is_good, part_schedule_id) VALUES (?, ?, ?, ?, ?)',
    [machineId, timestamp, cycleTime, isGood, machines[0].active_schedule_id || null]
  );

  // 3. Update machine metrics in the database.
  const countField = isGood ? 'good_count' : 'scrap_count';

  await db.query(
    `UPDATE machines SET
      production_count = production_count + 1,
      ${countField} = ${countField} + 1,
      last_pulse = ?
     WHERE id = ?`,
    [timestamp, machineId]
  );

  // 4. Recalculate OEE
  const oeeMetrics = await calculateOEE(machineId);

  // 5. Broadcast update to frontend clients
  if (wsBroadcastCallback) {
    wsBroadcastCallback({
      type: 'PULSE',
      machineId,
      pulse: { timestamp, cycleTime, isGood },
      metrics: oeeMetrics
    });
  }
}

/**
 * Handles a lightweight liveness heartbeat from a machine's ESP32 (sent every ~5s over serial,
 * see esp32_cnc_monitor.ino - or over MQTT on the "cnc/{machineId}/heartbeat" topic for any
 * future non-serial gateway). This is the ONLY signal watchdogService.js's edge-gateway
 * connectivity check uses (see applyScheduledParts's sibling stale-pulse block) - deliberately
 * decoupled from production entirely. Unlike handlePulseMessage/handleStatusMessage, this never
 * touches status, counts, OEE, or the WebSocket broadcast - a heartbeat isn't user-facing
 * telemetry, just a liveness timestamp, and recalculating/broadcasting on every 5s tick for every
 * machine would be pure overhead for zero informational gain (nothing production-relevant
 * changed).
 */
export async function handleHeartbeatMessage(machineId) {
  const timestamp = new Date();
  timestamp.setMilliseconds(0);
  // Serialized against watchdogService.js's connectivity check via the same per-machine lock -
  // this write and the watchdog's stale/fresh read-and-decide must never interleave, otherwise
  // the watchdog can act on a last_heartbeat value that's about to be superseded.
  await withMachineLock(machineId, async () => {
    await db.query('UPDATE machines SET last_heartbeat = ? WHERE id = ?', [timestamp, machineId]);
  });
}

/**
 * Handles status updates from machines
 */
export async function handleStatusMessage(machineId, status) {
  if (!['Running', 'Stopped', 'Not Connected'].includes(status)) {
    logger.warn(`Invalid status status received for ${machineId}: ${status}`);
    return;
  }

  // Self-locking: this is the single choke-point every status transition (MQTT publish, the
  // watchdog, sync, every route) funnels through, so acquiring the per-machine lock here - not
  // just at some call sites - guarantees two transitions for the same machine can never
  // interleave and leave more than one open status_logs row behind. withMachineLock is
  // reentrant, so callers that already hold this machineId's lock (e.g. POST /stop) are
  // unaffected.
  await withMachineLock(machineId, async () => {
    const timestamp = new Date();
    timestamp.setMilliseconds(0);

    // 1. Fetch current status of machine to check for transition
    const [machines] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) return;

    const currentStatus = machines[0].status;
    if (currentStatus !== status) {
      // 2. Update machine status in database
      await db.query('UPDATE machines SET status = ? WHERE id = ?', [status, machineId]);

      // Stopping the machine - whether the operator pressed Stop on the touchscreen, or the
      // watchdog auto-stopped it after no pulse for ideal_cycle_time + 2min - must not leave a
      // stale "last cycle time" on display from before this stop. Both paths funnel through here,
      // so this is the single choke-point for the reset (see calculateOEE() for the read side).
      if (status === 'Stopped') {
        await db.query('UPDATE machines SET last_cycle_reset_at = ? WHERE id = ?', [timestamp, machineId]);
      }

      // 3. Transition status logs
      await ensureActiveStatusLog(machineId, status, timestamp);
      logger.info(`🔌 Machine ${machineId} transitioned: ${currentStatus} ➡️ ${status}`);
    }

    // 4. Recalculate OEE
    const oeeMetrics = await calculateOEE(machineId);

    // 5. Broadcast update to frontend clients
    if (wsBroadcastCallback) {
      wsBroadcastCallback({
        type: 'STATUS_CHANGE',
        machineId,
        status,
        metrics: oeeMetrics
      });
    }
  });
}

/**
 * Handles resuming production with a downtime reason and operator tracking
 */
export async function handleResumeMessage(machineId, reason, operatorId = null) {
  // Self-locking (see handleStatusMessage) - resume races against the ESP32's own immediate
  // status telemetry are exactly what produced duplicate open status_logs rows historically;
  // reentrant so callers like POST /resume that already hold this machineId's lock are unaffected.
  return withMachineLock(machineId, () => handleResumeMessageLocked(machineId, reason, operatorId));
}

async function handleResumeMessageLocked(machineId, reason, operatorId) {
  const timestamp = new Date();
  timestamp.setMilliseconds(0);

  // 1. Fetch current status of machine
  const [machines] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
  if (machines.length === 0) return;

  const currentStatus = machines[0].status;

  // 2. Update machine status in database
  await db.query("UPDATE machines SET status = 'Running' WHERE id = ?", [machineId]);

  // 3. Set the downtime_reason on the Stopped log this resume is actually closing out.
  // IMPORTANT: target it by id (most recent 'Stopped' row for this machine), not by
  // "whichever log currently has end_time IS NULL". On a real Edge Gateway, the ESP32 sends its
  // own "status":"Running" telemetry immediately after the resume command - BEFORE it sends the
  // ack this route is awaiting (see firmware/esp32_cnc_monitor.ino's resume handler) - and that
  // telemetry independently races in via handleStatusMessage -> ensureActiveStatusLog, which
  // closes the open Stopped log with NO reason. If this function then matched "end_time IS
  // NULL" it would find only the *new* Running row that race just opened, and would tag the
  // operator's reason onto that Running-status row instead - permanently losing it, since the
  // real Stopped row it belonged to would already be closed with downtime_reason left NULL.
  // Matching on status='Stopped' instead makes this correct regardless of which side of that
  // race actually gets there first.
  const [machineLogs] = await db.query('SELECT * FROM status_logs WHERE machine_id = ?', [machineId]);
  const stoppedLog = machineLogs
    .filter((l) => l.status === 'Stopped')
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time))[0];

  if (stoppedLog) {
    // Preserve the existing end_time if the race above already closed it out; otherwise this
    // resume is what closes it, so stamp it with "now".
    const resolvedEndTime = stoppedLog.end_time || timestamp;
    await db.query(
      'UPDATE status_logs SET end_time = ?, downtime_reason = ?, synced = FALSE WHERE id = ?',
      [resolvedEndTime, reason, stoppedLog.id]
    );
  }

  // Close out any OTHER still-open log for this machine (e.g. a Running row the race above
  // already created) without touching its reason - Running periods never have a downtime
  // reason. Close EVERY such log, not just the first found - a resume racing the ESP32's own
  // immediate status telemetry (both independently touch status_logs with no locking between
  // them) can leave more than one open row; closing only one lets the rest live open forever,
  // and the watchdog's LEFT JOIN against status_logs then matches one result row per stray
  // duplicate, misfiring its stale-pulse check once per duplicate.
  const [activeLogs] = await db.query(
    'SELECT * FROM status_logs WHERE machine_id = ? AND end_time IS NULL',
    [machineId]
  );

  if (activeLogs.length > 0) {
    // Reset synced=FALSE: this may have already been uploaded to the cloud while it was
    // still open (no reason yet) - without this, the sync client's "WHERE synced = 0" query
    // never picks the row up again, and the downtime reason/end_time silently never reaches
    // the cloud dashboard.
    await db.query(
      'UPDATE status_logs SET end_time = ?, synced = FALSE WHERE machine_id = ? AND end_time IS NULL',
      [timestamp, machineId]
    );
  }

  // 4. Open a new active log for Running status with active operator ID. Same fallback as
  // ensureActiveStatusLogLocked - the (machine_id, is_open) unique constraint (db.js) is the
  // actual source of truth, not the close-then-insert above.
  try {
    await db.query(
      "INSERT INTO status_logs (machine_id, status, start_time, operator_id) VALUES (?, 'Running', ?, ?)",
      [machineId, timestamp, operatorId]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      await db.query(
        "UPDATE status_logs SET status = 'Running', start_time = ?, operator_id = ?, synced = FALSE WHERE machine_id = ? AND end_time IS NULL",
        [timestamp, operatorId, machineId]
      );
    } else {
      throw err;
    }
  }

  logger.info(`🔌 Machine ${machineId} resumed by ${operatorId || 'system'}: ${currentStatus} ➡️ Running (Reason: ${reason})`);

  // 5. Recalculate OEE
  const oeeMetrics = await calculateOEE(machineId);

  // 6. Broadcast update to frontend clients
  if (wsBroadcastCallback) {
    wsBroadcastCallback({
      type: 'STATUS_CHANGE',
      machineId,
      status: 'Running',
      metrics: oeeMetrics,
      downtimeReason: reason,
      operatorId: operatorId
    });
  }
}

/**
 * Ensures that the active status log matches the target status.
 * Closes out any older open status log and opens a new one if status changes.
 */
export async function ensureActiveStatusLog(machineId, targetStatus, timestamp) {
  // Self-locking (see handleStatusMessage) - this is the function that actually opens/closes
  // status_logs rows, and it used to be called directly (unlocked) from the watchdog's
  // resume-race self-heal, racing the MQTT publish handler's own unlocked call chain. That gap
  // is exactly what could leave two open rows for one machine, which then both got closed to
  // the same timestamp and showed up as duplicate 0s-duration log rows.
  return withMachineLock(machineId, () => ensureActiveStatusLogLocked(machineId, targetStatus, timestamp));
}

async function ensureActiveStatusLogLocked(machineId, targetStatus, timestamp) {
  if (timestamp) timestamp.setMilliseconds(0);
  // Check if there's already an active log with this status
  const [activeLogs] = await db.query(
    'SELECT * FROM status_logs WHERE machine_id = ? AND end_time IS NULL',
    [machineId]
  );

  // Already exactly one open log with the right status - nothing to do.
  if (activeLogs.length === 1 && activeLogs[0].status === targetStatus) {
    return;
  }

  if (activeLogs.length > 0) {
    // Close EVERY open log for this machine, not just the first one found - see
    // handleResumeMessage for why duplicates can occur and why leaving any open is what lets
    // the watchdog's LEFT JOIN misfire once per stray duplicate.
    // Reset synced=FALSE so the corrected end_time re-uploads even if this row already
    // synced to the cloud while it was still open.
    await db.query(
      'UPDATE status_logs SET end_time = ?, synced = FALSE WHERE machine_id = ? AND end_time IS NULL',
      [timestamp, machineId]
    );
  }

  // Open a new active log. The (machine_id, is_open) unique constraint (see db.js) is the real
  // guard against more than one open row per machine - the SELECT+UPDATE above is only an
  // in-process optimization to avoid hitting it in the common case. If some other writer (a
  // concurrent /sync/data batch, another process) won the race and opened a row in between,
  // fall back to updating it in place instead of crashing this caller.
  try {
    await db.query(
      'INSERT INTO status_logs (machine_id, status, start_time, end_time) VALUES (?, ?, ?, NULL)',
      [machineId, targetStatus, timestamp]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      await db.query(
        'UPDATE status_logs SET status = ?, start_time = ?, synced = FALSE WHERE machine_id = ? AND end_time IS NULL',
        [targetStatus, timestamp, machineId]
      );
    } else {
      throw err;
    }
  }
}
