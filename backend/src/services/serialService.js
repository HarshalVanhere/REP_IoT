import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import db from '../config/db.js';
import { handlePulseMessage, handleStatusMessage } from './mqttService.js';

let portInstance = null;
let reconnectTimer = null;

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
  portInstance.on('close', () => {
    console.warn(`❌ Serial: Port ${portPath} closed. Attempting reconnect in 5 seconds...`);
    scheduleReconnect(portPath, baudRate);
  });

  // Handle port errors
  portInstance.on('error', (err) => {
    console.error(`⚠️  Serial Error on port ${portPath}:`, err.message);
  });
}

/**
 * Sends a command to the ESP32 over serial (e.g. "resume" or "stop")
 */
export function sendSerialCommand(machineId, command) {
  if (machineId !== '1313') return;

  if (!portInstance || !portInstance.isOpen) {
    console.warn(`⚠️  Serial: Cannot send command "${command}". Port is not open.`);
    return;
  }

  const payload = JSON.stringify({ command });
  portInstance.write(payload + '\n', (err) => {
    if (err) {
      console.error(`❌ Serial: Error sending command "${command}":`, err.message);
    } else {
      console.log(`🔌 Serial: Sent control command ->`, payload);
    }
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
