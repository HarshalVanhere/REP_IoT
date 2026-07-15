import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';

import apiRouter from './routes/api.js';
import { startMQTTBroker } from './services/mqttService.js';
import { startSyncService } from './services/syncService.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRouter);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
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

// Start the HTTP server
server.listen(PORT, async () => {
  console.log(`💻 Express & WS Server running on http://localhost:${PORT}`);
});
