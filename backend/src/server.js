import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';

import path from 'path';
import { fileURLToPath } from 'url';

import apiRouter from './routes/api.js';
import { startMQTTBroker } from './services/mqttService.js';
import { startSyncService } from './services/syncService.js';
import { startSerialListener } from './services/serialService.js';
import { startWatchdogService } from './services/watchdogService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRouter);

// Serve static frontend build files
const frontendDistPath = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDistPath));

// Fallback to index.html for Single Page App routing (e.g. /operator)
app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDistPath, 'index.html'));
});

// Create HTTP server
const server = http.createServer(app);

// Create WebSocket server
const wss = new WebSocketServer({ server });
const connectedClients = new Set();

wss.on('connection', (ws) => {
  connectedClients.add(ws);
  console.log(`🔌 WebSocket Client connected (Total active: ${connectedClients.size})`);
  
  ws.send(JSON.stringify({
    type: 'WELCOME',
    timestamp: new Date(),
    message: 'Connected to CNC Dashboard WebSocket server'
  }));

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(`🔌 WebSocket Client disconnected (Total active: ${connectedClients.size})`);
  });

  ws.on('error', (err) => {
    console.error('WS client error:', err.message);
  });
});

/**
 * Broadcast message to all connected WebSocket clients
 */
function broadcast(data) {
  const jsonString = JSON.stringify(data);
  connectedClients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(jsonString);
    }
  });
}

// Start MQTT broker and pass the WebSocket broadcast callback
startMQTTBroker(broadcast);

// Register WebSocket broadcast callback on the API router for synchronized updates
apiRouter.setBroadcastCallback(broadcast);

// Start the background sync client (if configured as Edge Gateway)
startSyncService();

// Start the USB serial listener (if configured as Edge Gateway)
startSerialListener();

// Start the stale-pulse watchdog service
startWatchdogService();

// Start the HTTP server
server.listen(PORT, async () => {
  console.log(`💻 Express & WS Server running on http://localhost:${PORT}`);
});
