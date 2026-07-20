import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import path from 'path';
import { fileURLToPath } from 'url';

import apiRouter from './routes/api.js';
import authRouter from './routes/auth.js';
import partSchedulesRouter from './routes/partSchedules.js';
import db from './config/db.js';
import { verifyToken } from './middleware/auth.js';
import { startMQTTBroker } from './services/mqttService.js';
import { startSyncService } from './services/syncService.js';
import { startSerialListener } from './services/serialService.js';
import { startWatchdogService, stopWatchdogService } from './services/watchdogService.js';
import { logger } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// A process running unattended 24x7 on a factory floor must never die silently.
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception (process staying alive):', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection (process staying alive):', reason instanceof Error ? reason.stack : reason);
});

const app = express();
const PORT = process.env.PORT || 5000;
const startedAt = Date.now();

app.use(helmet({
  // The API is consumed by a separate frontend build (and cross-origin in cloud mode),
  // so a strict default CSP would just break legitimate requests without adding value here.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: false
}));

// CORS: restrict to configured origin(s) in production; wide open in dev for convenience.
const corsOrigin = process.env.CORS_ORIGIN;
if (!corsOrigin && process.env.NODE_ENV === 'production') {
  logger.warn('CORS_ORIGIN is not set in production - allowing all origins. Set it to your dashboard\'s real origin(s).');
}
app.use(cors({
  origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : true
}));

app.use(express.json());

// Generous global rate limit - protects against runaway clients/scripts, not meant to
// throttle normal dashboard polling. Login has its own stricter limiter (see auth.js).
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    database: db.isMock ? 'mock' : 'connected',
    edgeGateway: process.env.IS_EDGE_GATEWAY === 'true',
    timestamp: new Date().toISOString()
  });
});

app.use('/api/auth', authRouter);
app.use('/api/part-schedules', partSchedulesRouter);
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

wss.on('connection', (ws, req) => {
  // Production telemetry (machine status, counts) is only for logged-in dashboard users -
  // require the same JWT issued by POST /api/auth/login, passed as ?token=... on the WS URL.
  const requestUrl = new URL(req.url, 'http://internal');
  const token = requestUrl.searchParams.get('token');
  const user = token ? verifyToken(token) : null;

  if (!user) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  connectedClients.add(ws);
  logger.info(`🔌 WebSocket Client connected (Total active: ${connectedClients.size})`);

  ws.send(JSON.stringify({
    type: 'WELCOME',
    timestamp: new Date(),
    message: 'Connected to CNC Dashboard WebSocket server'
  }));

  ws.on('close', () => {
    connectedClients.delete(ws);
    logger.info(`🔌 WebSocket Client disconnected (Total active: ${connectedClients.size})`);
  });

  ws.on('error', (err) => {
    logger.error('WS client error:', err.message);
  });
});

// Heartbeat: evicts dead sockets that never sent a close frame (e.g. a kiosk tablet that
// lost power or network mid-session) so connectedClients doesn't grow unbounded over 24x7 uptime.
const heartbeatInterval = setInterval(() => {
  connectedClients.forEach((ws) => {
    if (ws.isAlive === false) {
      connectedClients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

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
startWatchdogService(broadcast);

// Start the HTTP server
server.listen(PORT, () => {
  logger.info(`💻 Express & WS Server running on http://localhost:${PORT}`);
});

// Graceful shutdown - important for a systemd-managed service (see cnc-backend.service)
// so restarts/deploys don't corrupt in-flight DB writes or leave the serial port locked.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received. Shutting down gracefully...`);

  clearInterval(heartbeatInterval);
  stopWatchdogService();

  wss.clients.forEach((client) => client.close());

  server.close(() => {
    logger.info('HTTP server closed.');
  });

  const pool = db.getPool();
  if (pool) {
    await pool.end();
    logger.info('Database pool closed.');
  }

  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
