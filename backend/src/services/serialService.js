import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import db from '../config/db.js';
import { handlePulseMessage, handleStatusMessage } from './mqttService.js';

let portInstance = null;
let reconnectTimer = null;
const pendingAcks = new Map(); // command -> { resolve, reject, timeout }

/**
 * Starts the Serial port listener on the Edge Gateway
 */
export function startSerialListener() {
  const isEdgeGateway = process.env.IS_EDGE_GATEWAY === 'true';
  const portPath = process.env.SERIAL_PORT || '/dev/ttyUSB0';
  const baudRate = parseInt(process.env.SERIAL_BAUD || '115200');

  if (!isEdgeGateway) {
    console.log('☁️  Running in Cloud Mode (Serial Listener Disabled)');
    return;
  }

  console.log(`🔌 Attempting to open Serial Port: ${portPath} @ ${baudRate} baud`);
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

  portInstance.open(async (err) => {
    if (err) {
      console.warn(`❌ Serial: Failed to open port ${portPath}: ${err.message}. Retrying in 5 seconds...`);
      await handleStatusMessage("1313", "No Signal");
      scheduleReconnect(portPath, baudRate);
      return;
    }
    console.log(`✅ Serial: Port ${portPath} opened successfully.`);

    // Boot Sync: Retrieve the last known database status and ensure ESP32 relay matches it
    try {
      const [rows] = await db.query('SELECT status FROM machines WHERE id = "1313"');
      if (rows.length > 0) {
        const dbStatus = rows[0].status;
        console.log(`🔌 Serial Boot Sync: Syncing interlock to match DB state "${dbStatus}"`);
        if (dbStatus === 'Running') {
          sendSerialCommand("1313", "resume");
        } else {
          sendSerialCommand("1313", "stop");
        }
      }
    } catch (dbErr) {
      console.error('❌ Serial Boot Sync: Failed to query DB status:', dbErr.message);
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
        console.log(`📠 Serial: [ESP32 LOG] ${payload.message}`);
        return;
      }

      // If it is an acknowledgement
      if (payload.type === 'ack') {
        const command = payload.command;
        const pending = pendingAcks.get(command);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingAcks.delete(command);
          console.log(`✅ Serial: Command "${command}" acknowledged by ESP32.`);
          pending.resolve(payload);
        }
        return;
      }

      console.log(`🔌 Serial: Received telemetry ->`, payload);

      if (payload.type === 'pulse') {
        const cycleTime = parseFloat(payload.cycleTime || 15);
        // Direct integration: 1 pulse = 1 production count
        await handlePulseMessage("1313", { cycleTime, isGood: true });
      } else if (payload.type === 'status') {
        const status = payload.status;
        await handleStatusMessage("1313", status);
      }
    } catch (err) {
      console.warn(`⚠️  Serial: Failed to parse line: "${trimmed}" - Error: ${err.message}`);
    }
  });

  // Handle port close
  portInstance.on('close', async () => {
    console.warn(`❌ Serial: Port ${portPath} closed. Attempting reconnect in 5 seconds...`);
    await handleStatusMessage("1313", "No Signal");
    scheduleReconnect(portPath, baudRate);
  });

  // Handle port errors
  portInstance.on('error', (err) => {
    console.error(`⚠️  Serial Error on port ${portPath}:`, err.message);
  });
}

/**
 * Sends a command to the ESP32 over serial (e.g. "resume" or "stop")
 * Returns a Promise that resolves when the ESP32 acknowledges the command.
 */
export function sendSerialCommand(machineId, command) {
  const isEdgeGateway = process.env.IS_EDGE_GATEWAY === 'true';
  if (!isEdgeGateway) {
    console.log(`☁️ Cloud Mode: Simulating serial command "${command}" for machine ${machineId}`);
    return Promise.resolve({ type: 'ack', command, status: 'success' });
  }

  if (machineId !== '1313') {
    return Promise.reject(new Error('Invalid machine ID for serial interlock'));
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
        console.log(`🔌 Serial: Sent control command ->`, payload);
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
