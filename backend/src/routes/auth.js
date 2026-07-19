import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import db from '../config/db.js';
import { issueToken, requireAuth } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Blunt brute-force attempts against the login endpoint specifically.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait a few minutes and try again.' }
});

/**
 * POST /api/auth/login
 * Verifies loginId + password against the stored bcrypt hash and issues a signed JWT.
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { loginId, password } = req.body;

  if (!loginId || !password) {
    return res.status(400).json({ error: 'Login ID and password are required' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE loginId = ?', [loginId.trim().toUpperCase()]);
    const user = rows[0];

    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid login ID or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Invalid login ID or password' });
    }

    const token = issueToken(user);
    await recordAuditLog(user.loginId, 'LOGIN', user.loginId);

    res.json({
      token,
      user: {
        loginId: user.loginId,
        role: user.role,
        displayName: user.displayName,
        terminalId: user.terminalId
      }
    });
  } catch (err) {
    logger.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed due to a server error' });
  }
});

/**
 * POST /api/auth/change-password
 * Authenticated users may change their own password.
 */
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required' });
  }
  if (newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM users WHERE loginId = ?', [req.user.loginId]);
    const user = rows[0];
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passwordMatches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!passwordMatches) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await db.query('UPDATE users SET password_hash = ? WHERE loginId = ?', [newHash, req.user.loginId]);
    await recordAuditLog(req.user.loginId, 'CHANGE_PASSWORD', req.user.loginId);

    res.json({ success: true, message: 'Password updated successfully' });
  } catch (err) {
    logger.error('Change password error:', err.message);
    res.status(500).json({ error: 'Failed to change password' });
  }
});

/**
 * GET /api/auth/me - lets the frontend validate a stored token on reload.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
