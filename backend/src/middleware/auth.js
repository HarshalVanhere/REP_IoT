import jwt from 'jsonwebtoken';
import { logger } from '../utils/logger.js';

// A JWT secret is mandatory in production - refuse to run with a guessable default.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is not set. It is required in production mode to sign session tokens.');
  }
  logger.warn('JWT_SECRET is not set. Using an insecure development-only default - do not deploy like this.');
}
const SECRET = JWT_SECRET || 'dev-only-insecure-secret-change-me';
const TOKEN_EXPIRY = '10h';

export function issueToken(user) {
  return jwt.sign(
    { loginId: user.loginId, role: user.role, displayName: user.displayName, terminalId: user.terminalId },
    SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * Verifies a raw token string, returning the decoded payload or null.
 * Used outside of Express request handling (e.g. the raw WebSocket upgrade).
 */
export function verifyToken(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

/**
 * Requires a valid Bearer JWT. Attaches the decoded payload to req.user.
 */
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Restricts a route to specific roles. Must run after requireAuth.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action' });
    }
    next();
  };
}

/**
 * Machine-to-machine auth for the edge-gateway sync endpoint - not a user session.
 */
export function requireSyncKey(req, res, next) {
  const expected = process.env.SYNC_API_KEY;
  if (!expected) {
    logger.warn('SYNC_API_KEY is not set - /api/sync/data is unprotected. Set SYNC_API_KEY on both cloud and gateway.');
    return next();
  }
  const provided = req.headers['x-sync-key'];
  if (provided !== expected) {
    return res.status(401).json({ error: 'Invalid or missing sync key' });
  }
  next();
}
