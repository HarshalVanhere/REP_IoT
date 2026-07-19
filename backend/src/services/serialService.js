import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import db from '../config/db.js';
import { handlePulseMessage, handleStatusMessage } from './mqttService.js';
import { logger } from '../utils/logger.js';

let portInstance = null;
let reconnectTimer = null;
const pendingAcks = new Map(); // command -> { resolve, reject, timeout }

/**
 * Each Pi + ESP32 edge gateway is wired to exactly one physical machine, identified by
 * this env var. This is what lets the same code run unmodified on every deployed gateway -
 * only the .env changes per machine, never the source.
 */
function getGatewayMachineId() {
  return process.env.GATEWAY_MACHINE_ID;
}

/**
 * Starts the Serial port listener on the Edge Gateway
 */
export function startSerialListener() {
  const isEdgeGateway = process.env.IS_EDGE_GATEWAY === 'true';
  const portPath = process.env.SERIAL_PORT || '/dev/ttyUSB0';
  const baudRate = parseInt(process.env.SERIAL_BAUD || '115200');

  if (!isEdgeGateway) {
    logger.info('☁️  Running in Cloud Mode (Serial Listener Disabled)');
    return;
  }

  if (!getGatewayMachineId()) {
    logger.error('IS_EDGE_GATEWAY=true but GATEWAY_MACHINE_ID is not set. This gateway does not know which machine it is wired to. Serial listener will not start.');
    return;
  }

  logger.info(`🔌 Attempting to open Serial Port: ${portPath} @ ${baudRate} baud for machine ${getGatewayMachineId()}`);
  connectSerial(portPath, baudRate);
}

/**
 * Connects and configures the serial port connection with automatic reconnection logic
 */
function connectSerial(portPath, baudRate) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  portInstance = new SerialPort({
    path: portPath,
    baudRate: baudRate,
    autoOpen: false
  });

  // Use Readline parser to read data line-by-line
  const parser = portInstance.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  const gatewayMachineId = getGatewayMachineId();

  portInstance.open(async (err) => {
    if (err) {
      logger.warn(`Serial: Failed to open port ${portPath}: ${err.message}. Retrying in 5 seconds...`);
      await handleStatusMessage(gatewayMachineId, "No Signal");
      scheduleReconnect(portPath, baudRate);
      return;
    }
    logger.info(`✅ Serial: Port ${portPath} opened successfully.`);

    // Boot Sync: Retrieve the last known database status and ensure ESP32 relay matches it
    try {
      const [rows] = await db.query('SELECT status FROM machines WHERE id = ?', [gatewayMachineId]);
      if (rows.length > 0) {
        const dbStatus = rows[0].status;
        logger.info(`🔌 Serial Boot Sync: Syncing interlock to match DB state "${dbStatus}"`);
        if (dbStatus === 'Running') {
          sendSerialCommand(gatewayMachineId, "resume");
        } else {
          sendSerialCommand(gatewayMachineId, "stop");
        }
      } else {
        logger.error(`Serial Boot Sync: Machine "${gatewayMachineId}" (GATEWAY_MACHINE_ID) does not exist in the database.`);
      }
    } catch (dbErr) {
      logger.error('Serial Boot Sync: Failed to query DB status:', dbErr.message);
    }
  });

  // Receive telemetry messages
  parser.on('data', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const payload = JSON.parse(trimmed);

      // If it is a log confirmation message from the ESP32
      if (payload.type === 'log') {
        logger.debug(`📠 Serial: [ESP32 LOG] ${payload.message}`);
        return;
      }

      // If it is an acknowledgement
      if (payload.type === 'ack') {
        const command = payload.command;
        const pending = pendingAcks.get(command);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingAcks.delete(command);
          logger.info(`✅ Serial: Command "${command}" acknowledged by ESP32.`);
          pending.resolve(payload);
        }
        return;
      }

      logger.debug(`🔌 Serial: Received telemetry ->`, payload);

      if (payload.type === 'pulse') {
        const cycleTime = parseFloat(payload.cycleTime || 15);
        // Direct integration: 1 pulse = 1 production count
        await handlePulseMessage(gatewayMachineId, { cycleTime, isGood: true });
      } else if (payload.type === 'status') {
        const status = payload.status;
        await handleStatusMessage(gatewayMachineId, status);
      }
    } catch (err) {
      logger.warn(`Serial: Failed to parse line: "${trimmed}" - Error: ${err.message}`);
    }
  });

  // Handle port close
  portInstance.on('close', async () => {
    logger.warn(`Serial: Port ${portPath} closed. Attempting reconnect in 5 seconds...`);
    await handleStatusMessage(gatewayMachineId, "No Signal");
    scheduleReconnect(portPath, baudRate);
  });

  // Handle port errors
  portInstance.on('error', (err) => {
    logger.error(`Serial Error on port ${portPath}:`, err.message);
  });
}

/**
 * Sends a command to the ESP32 over serial (e.g. "resume" or "stop")
 * Returns a Promise that resolves when the ESP32 acknowledges the command.
 */
export function sendSerialCommand(machineId, command) {
  const isEdgeGateway = process.env.IS_EDGE_GATEWAY === 'true';
  if (!isEdgeGateway) {
    logger.debug(`☁️ Cloud Mode: Simulating serial command "${command}" for machine ${machineId}`);
    return Promise.resolve({ type: 'ack', command, status: 'success' });
  }

  if (machineId !== getGatewayMachineId()) {
    return Promise.reject(new Error(`Machine ${machineId} is not the machine wired to this gateway (GATEWAY_MACHINE_ID=${getGatewayMachineId()})`));
  }

  if (!portInstance || !portInstance.isOpen) {
    return Promise.reject(new Error('Serial port is not open'));
  }

  return new Promise((resolve, reject) => {
    // If there is already a pending command of this type, reject it first
    const existing = pendingAcks.get(command);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.reject(new Error(`Superceded by new "${command}" command`));
      pendingAcks.delete(command);
    }

    const payload = JSON.stringify({ command });
    
    const timeout = setTimeout(() => {
      pendingAcks.delete(command);
      reject(new Error(`Timeout waiting for ESP32 acknowledgement for command: ${command}`));
    }, 2000);

    pendingAcks.set(command, { resolve, reject, timeout });

    portInstance.write(payload + '\n', (err) => {
      if (err) {
        clearTimeout(timeout);
        pendingAcks.delete(command);
        reject(new Error(`Failed to write to serial port: ${err.message}`));
      } else {
        logger.info(`🔌 Serial: Sent control command ->`, payload);
      }
    });
  });
}

/**
 * Schedules a reconnection attempt
 */
function scheduleReconnect(portPath, baudRate) {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      connectSerial(portPath, baudRate);
    }, 5000);
  }
}
