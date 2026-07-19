import Aedes from 'aedes';
import net from 'net';
import db from '../config/db.js';
import { calculateOEE } from './oeeCalculator.js';
import { logger } from '../utils/logger.js';

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

        if (messageType === 'pulse') {
          await handlePulseMessage(machineId, payload);
        } else if (messageType === 'status') {
          await handleStatusMessage(machineId, payload.status || payload.value);
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

  // 2. Insert pulse log into database
  await db.query(
    'INSERT INTO pulses (machine_id, timestamp, cycle_time, is_good) VALUES (?, ?, ?, ?)',
    [machineId, timestamp, cycleTime, isGood]
  );

  // 3. Update machine metrics in the database.
  // IMPORTANT: do NOT blindly force status back to 'Running' here. A pulse can legitimately
  // arrive right after an operator/watchdog Stop - the CNC's in-flight cycle finishes and the
  // ESP32 reports it over serial even though the interlock relay has already been de-energized.
  // Counting that trailing part is correct; silently flipping the machine back to Running is not
  // - it would undo an Emergency Stop the moment the residual cycle completes. Only auto-resume
  // to Running when the machine wasn't deliberately Stopped (e.g. it was Running or reconnecting
  // from No Signal).
  const currentStatus = machines[0].status;
  const countField = isGood ? 'good_count' : 'scrap_count';

  if (currentStatus === 'Stopped') {
    await db.query(
      `UPDATE machines SET
        production_count = production_count + 1,
        ${countField} = ${countField} + 1,
        last_pulse = ?
       WHERE id = ?`,
      [timestamp, machineId]
    );
  } else {
    await db.query(
      `UPDATE machines SET
        production_count = production_count + 1,
        ${countField} = ${countField} + 1,
        last_pulse = ?,
        status = 'Running'
       WHERE id = ?`,
      [timestamp, machineId]
    );

    // Ensure machine is set to running and has active status log
    await ensureActiveStatusLog(machineId, 'Running', timestamp);
  }

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
 * Handles status updates from machines
 */
export async function handleStatusMessage(machineId, status) {
  if (!['Running', 'Stopped', 'No Signal'].includes(status)) {
    logger.warn(`Invalid status status received for ${machineId}: ${status}`);
    return;
  }

  const timestamp = new Date();
  timestamp.setMilliseconds(0);

  // 1. Fetch current status of machine to check for transition
  const [machines] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
  if (machines.length === 0) return;

  const currentStatus = machines[0].status;
  if (currentStatus !== status) {
    // 2. Update machine status in database
    await db.query('UPDATE machines SET status = ? WHERE id = ?', [status, machineId]);
    
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
}

/**
 * Handles resuming production with a downtime reason and operator tracking
 */
export async function handleResumeMessage(machineId, reason, operatorId = null) {
  const timestamp = new Date();
  timestamp.setMilliseconds(0);

  // 1. Fetch current status of machine
  const [machines] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
  if (machines.length === 0) return;

  const currentStatus = machines[0].status;
  
  // 2. Update machine status in database
  await db.query("UPDATE machines SET status = 'Running' WHERE id = ?", [machineId]);

  // 3. Close the active status log (usually Stopped) and set its downtime_reason
  const [activeLogs] = await db.query(
    'SELECT * FROM status_logs WHERE machine_id = ? AND end_time IS NULL',
    [machineId]
  );

  if (activeLogs.length > 0) {
    const activeLog = activeLogs[0];
    // Reset synced=FALSE: this row may have already been uploaded to the cloud while it was
    // still open (no reason yet) - without this, the sync client's "WHERE synced = 0" query
    // never picks the row up again, and the downtime reason/end_time silently never reaches
    // the cloud dashboard.
    await db.query(
      'UPDATE status_logs SET end_time = ?, downtime_reason = ?, synced = FALSE WHERE id = ?',
      [timestamp, reason, activeLog.id]
    );
  }

  // 4. Open a new active log for Running status with active operator ID
  await db.query(
    "INSERT INTO status_logs (machine_id, status, start_time, operator_id) VALUES (?, 'Running', ?, ?)",
    [machineId, timestamp, operatorId]
  );

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
async function ensureActiveStatusLog(machineId, targetStatus, timestamp) {
  if (timestamp) timestamp.setMilliseconds(0);
  // Check if there's already an active log with this status
  const [activeLogs] = await db.query(
    'SELECT * FROM status_logs WHERE machine_id = ? AND end_time IS NULL',
    [machineId]
  );

  if (activeLogs.length > 0) {
    const activeLog = activeLogs[0];
    if (activeLog.status === targetStatus) {
      // Already correct, do nothing
      return;
    }
    
    // Status has changed! Close the active log.
    // Reset synced=FALSE so the corrected end_time re-uploads even if this row already
    // synced to the cloud while it was still open (see handleResumeMessage for the same fix).
    await db.query(
      'UPDATE status_logs SET end_time = ?, synced = FALSE WHERE id = ?',
      [timestamp, activeLog.id]
    );
  }

  // Open a new active log
  await db.query(
    'INSERT INTO status_logs (machine_id, status, start_time, end_time) VALUES (?, ?, ?, NULL)',
    [machineId, targetStatus, timestamp]
  );
}
