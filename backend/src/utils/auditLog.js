import db from '../config/db.js';
import { logger } from './logger.js';

/**
 * Records a sensitive action for traceability (login, stop/resume, user/machine CRUD, planning changes).
 * Never throws - an audit logging failure must not block the underlying action.
 */
export async function recordAuditLog(actorLoginId, action, target = null, details = null) {
  try {
    await db.query(
      'INSERT INTO audit_log (actor_login_id, action, target, details) VALUES (?, ?, ?, ?)',
      [actorLoginId || 'system', action, target, details]
    );
  } catch (err) {
    logger.error('Failed to write audit log entry:', err.message);
  }
}
