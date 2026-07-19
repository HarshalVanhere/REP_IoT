import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../config/db.js';
import { calculateOEE } from '../services/oeeCalculator.js';
import { handleStatusMessage, handleResumeMessage, publishMQTT } from '../services/mqttService.js';
import { sendSerialCommand } from '../services/serialService.js';
import { requireAuth, requireRole, requireSyncKey } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { PREDEFINED_REASONS } from '../config/reasonCodes.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/**
 * Fetch all machines with real-time OEE metrics
 */
router.get('/machines', requireAuth, async (req, res) => {
  try {
    const [machines] = await db.query('SELECT * FROM machines');

    const enrichedMachines = await Promise.all(
      machines.map(async (machine) => {
        const metrics = await calculateOEE(machine.id);
        return {
          ...machine,
          metrics
        };
      })
    );

    res.json(enrichedMachines);
  } catch (err) {
    logger.error('API Error: GET /machines:', err.message);
    res.status(500).json({ error: 'Failed to retrieve machines list' });
  }
});

/**
 * Fetch pulse history for a specific machine (last 30 pulses)
 */
router.get('/machines/:id/history', requireAuth, async (req, res) => {
  const machineId = req.params.id;
  try {
    const [pulses] = await db.query(
      'SELECT id, timestamp, cycle_time, is_good FROM pulses WHERE machine_id = ? ORDER BY timestamp DESC LIMIT 30',
      [machineId]
    );
    // Return chronologically (oldest to newest)
    res.json(pulses.reverse());
  } catch (err) {
    logger.error(`API Error: GET /machines/${machineId}/history:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve pulse history' });
  }
});

/**
 * Stop machine (Operator touchscreen interface action)
 */
router.post('/machines/:id/stop', requireAuth, requireRole('Operator', 'Supervisor', 'Admin'), async (req, res) => {
  const machineId = req.params.id;
  try {
    // 1. Trigger physical machine lockout and wait for ESP32 confirmation
    await sendSerialCommand(machineId, 'stop');

    // 2. Only transition database/status after serial confirmation
    await handleStatusMessage(machineId, 'Stopped');
    await recordAuditLog(req.user.loginId, 'MACHINE_STOP', machineId);

    res.json({ success: true, message: `CNC Machine ${machineId} status set to Stopped (Confirmed by hardware)` });
  } catch (err) {
    logger.error(`API Error: POST /machines/${machineId}/stop:`, err.message);
    res.status(500).json({ error: `Failed to stop CNC machine: ${err.message}` });
  }
});

/**
 * Resume machine with downtime reason (Operator touchscreen interface action)
 */
router.post('/machines/:id/resume', requireAuth, requireRole('Operator', 'Supervisor', 'Admin'), async (req, res) => {
  const machineId = req.params.id;
  const { reason, operatorId } = req.body;

  if (!reason) {
    return res.status(400).json({ error: 'Downtime reason is required to resume production' });
  }

  try {
    // 1. Trigger physical machine run enablement and wait for ESP32 confirmation
    await sendSerialCommand(machineId, 'resume');

    // 2. Only transition database/status after serial confirmation
    await handleResumeMessage(machineId, reason, operatorId);
    await recordAuditLog(req.user.loginId, 'MACHINE_RESUME', machineId, reason);

    res.json({ success: true, message: `CNC Machine ${machineId} resumed in Running state (Confirmed by hardware)` });
  } catch (err) {
    logger.error(`API Error: POST /machines/${machineId}/resume:`, err.message);
    res.status(500).json({ error: `Failed to resume CNC machine: ${err.message}` });
  }
});

/**
 * Fetch logs history for plant management reports
 */
router.get('/reports', requireAuth, async (req, res) => {
  try {
    const [reports] = await db.query(`
      SELECT sl.id, sl.machine_id, m.name as machine_name, m.department as machine_section, sl.status, sl.start_time, sl.end_time, sl.downtime_reason, sl.operator_id, sl.part_name
      FROM status_logs sl
      JOIN machines m ON sl.machine_id = m.id
      ORDER BY sl.start_time DESC
      LIMIT 100
    `);
    res.json(reports);
  } catch (err) {
    logger.error('API/Reports Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve reports log' });
  }
});

/**
 * Machine Management CRUD (Admin only) - lets the plant add/edit/remove physical machines
 * without editing source code or re-running the seed script.
 */
router.post('/machines', requireAuth, requireRole('Admin'), async (req, res) => {
  const { id, name, department, target, ideal_cycle_time, active_part_name, assigned_operator } = req.body;

  if (!id || !name || !department) {
    return res.status(400).json({ error: 'id, name, and department are required' });
  }

  try {
    const [existing] = await db.query('SELECT id FROM machines WHERE id = ?', [id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: `Machine ${id} already exists` });
    }

    await db.query(
      'INSERT INTO machines (id, name, department, target, ideal_cycle_time, active_part_name, assigned_operator) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id.trim(), name.trim(), department.trim(), parseInt(target) || 500, parseInt(ideal_cycle_time) || 15, active_part_name || 'Unassigned', assigned_operator || 'Unassigned']
    );
    await recordAuditLog(req.user.loginId, 'MACHINE_CREATE', id);

    res.json({ success: true, message: `Machine ${id} created successfully` });
  } catch (err) {
    logger.error('API Error: POST /machines:', err.message);
    res.status(500).json({ error: 'Failed to create machine' });
  }
});

router.put('/machines/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const machineId = req.params.id;
  const { name, department, target, ideal_cycle_time } = req.body;

  if (!name || !department || target === undefined || ideal_cycle_time === undefined) {
    return res.status(400).json({ error: 'name, department, target, and ideal_cycle_time are required' });
  }

  try {
    await db.query(
      'UPDATE machines SET name = ?, department = ?, target = ?, ideal_cycle_time = ? WHERE id = ?',
      [name.trim(), department.trim(), parseInt(target), parseInt(ideal_cycle_time), machineId]
    );
    await recordAuditLog(req.user.loginId, 'MACHINE_UPDATE', machineId);

    res.json({ success: true, message: `Machine ${machineId} updated successfully` });
  } catch (err) {
    logger.error(`API Error: PUT /machines/${machineId}:`, err.message);
    res.status(500).json({ error: 'Failed to update machine' });
  }
});

router.delete('/machines/:id', requireAuth, requireRole('Admin'), async (req, res) => {
  const machineId = req.params.id;
  try {
    await db.query('DELETE FROM machines WHERE id = ?', [machineId]);
    await recordAuditLog(req.user.loginId, 'MACHINE_DELETE', machineId);

    res.json({ success: true, message: `Machine ${machineId} deleted successfully` });
  } catch (err) {
    logger.error(`API Error: DELETE /machines/${machineId}:`, err.message);
    res.status(500).json({ error: 'Failed to delete machine' });
  }
});

/**
 * Fetch all user profiles for CRUD management (Admin only)
 */
router.get('/users', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const [users] = await db.query('SELECT * FROM users');
    // Never expose password hashes to the client
    res.json(users.map(({ password_hash, ...safe }) => safe));
  } catch (err) {
    logger.error('API Error: GET /users:', err.message);
    res.status(500).json({ error: 'Failed to retrieve user profiles list' });
  }
});

/**
 * Create a new user profile (Admin only)
 */
router.post('/users', requireAuth, requireRole('Admin'), async (req, res) => {
  const { loginId, role, displayName, terminalId, password } = req.body;
  if (!loginId || !role || !displayName || !terminalId || !password) {
    return res.status(400).json({ error: 'loginId, role, displayName, terminalId, and password are required' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'INSERT INTO users (loginId, role, displayName, terminalId, password_hash) VALUES (?, ?, ?, ?, ?)',
      [loginId.trim().toUpperCase(), role.trim(), displayName.trim(), terminalId.trim(), passwordHash]
    );
    await recordAuditLog(req.user.loginId, 'USER_CREATE', loginId.trim().toUpperCase());
    res.json({ success: true, message: `User profile ${loginId} created successfully` });
  } catch (err) {
    logger.error('API Error: POST /users:', err.message);
    res.status(500).json({ error: 'Failed to create user profile' });
  }
});

/**
 * Update an existing user profile (Admin only). Password is optional - only changed if provided.
 */
router.put('/users/:loginId', requireAuth, requireRole('Admin'), async (req, res) => {
  const loginId = req.params.loginId;
  const { role, displayName, terminalId, password } = req.body;
  if (!role || !displayName || !terminalId) {
    return res.status(400).json({ error: 'role, displayName, and terminalId are required' });
  }
  try {
    await db.query(
      'UPDATE users SET role = ?, displayName = ?, terminalId = ? WHERE loginId = ?',
      [role.trim(), displayName.trim(), terminalId.trim(), loginId]
    );
    if (password) {
      if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      await db.query('UPDATE users SET password_hash = ? WHERE loginId = ?', [passwordHash, loginId]);
    }
    await recordAuditLog(req.user.loginId, 'USER_UPDATE', loginId);
    res.json({ success: true, message: `User profile ${loginId} updated successfully` });
  } catch (err) {
    logger.error('API Error: PUT /users:', err.message);
    res.status(500).json({ error: 'Failed to update user profile' });
  }
});

/**
 * Delete a user profile (Admin only)
 */
router.delete('/users/:loginId', requireAuth, requireRole('Admin'), async (req, res) => {
  const loginId = req.params.loginId;
  if (loginId === 'ADMIN') {
    return res.status(400).json({ error: 'The default ADMIN account cannot be deleted' });
  }
  try {
    await db.query('DELETE FROM users WHERE loginId = ?', [loginId]);
    await recordAuditLog(req.user.loginId, 'USER_DELETE', loginId);
    res.json({ success: true, message: `User profile ${loginId} deleted successfully` });
  } catch (err) {
    logger.error('API Error: DELETE /users:', err.message);
    res.status(500).json({ error: 'Failed to delete user profile' });
  }
});

/**
 * Downtime reason codes - single source of truth, shared by OEE aggregation and the frontend.
 */
router.get('/reason-codes', requireAuth, (req, res) => {
  res.json(PREDEFINED_REASONS);
});

/**
 * Audit log (Admin only) - who did what, for traceability on a factory-floor system.
 */
router.get('/audit-log', requireAuth, requireRole('Admin'), async (req, res) => {
  try {
    const [entries] = await db.query('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 200');
    res.json(entries);
  } catch (err) {
    logger.error('API Error: GET /audit-log:', err.message);
    res.status(500).json({ error: 'Failed to retrieve audit log' });
  }
});

let wsBroadcastCallback = null;
router.setBroadcastCallback = (cb) => {
  wsBroadcastCallback = cb;
};

/**
 * Receive batch synchronization data from Edge Gateways.
 * Authenticated via a shared SYNC_API_KEY header (machine-to-machine), not a user session.
 */
router.post('/sync/data', requireSyncKey, async (req, res) => {
  const { pulses, statusLogs } = req.body;

  if (!pulses || !statusLogs) {
    return res.status(400).json({ error: 'Invalid sync payload' });
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Process batch pulses
    for (const pulse of pulses) {
      // Check if pulse already exists in cloud DB to prevent duplication
      const [existing] = await connection.query(
        'SELECT id FROM pulses WHERE machine_id = ? AND timestamp = ? AND cycle_time = ?',
        [pulse.machine_id, new Date(pulse.timestamp), pulse.cycle_time]
      );

      if (existing.length === 0) {
        // Insert pulse
        await connection.query(
          'INSERT INTO pulses (machine_id, timestamp, cycle_time, is_good, synced) VALUES (?, ?, ?, ?, TRUE)',
          [pulse.machine_id, new Date(pulse.timestamp), pulse.cycle_time, pulse.is_good]
        );

        // Update machine stats. Deliberately does NOT force status='Running' - these can be
        // buffered/historical pulses synced well after the fact, and the statusLogs batch
        // below is the authoritative source for current machine status. Forcing it here could
        // flip a machine that is genuinely Stopped back to Running on the cloud dashboard.
        const countField = pulse.is_good ? 'good_count' : 'scrap_count';
        await connection.query(
          `UPDATE machines SET
            production_count = production_count + 1,
            ${countField} = ${countField} + 1,
            last_pulse = ?
           WHERE id = ?`,
          [new Date(pulse.timestamp), pulse.machine_id]
        );
      }
    }

    // 2. Process batch status logs
    for (const log of statusLogs) {
      // Check if log already exists in cloud DB
      const [existing] = await connection.query(
        'SELECT id FROM status_logs WHERE machine_id = ? AND status = ? AND start_time = ?',
        [log.machine_id, log.status, new Date(log.start_time)]
      );

      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO status_logs (machine_id, status, start_time, end_time, downtime_reason, operator_id, part_name, synced) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)',
          [
            log.machine_id,
            log.status,
            new Date(log.start_time),
            log.end_time ? new Date(log.end_time) : null,
            log.downtime_reason,
            log.operator_id,
            log.part_name
          ]
        );

        // Update the machine's current status if this log is active (end_time is null) or newer
        if (!log.end_time) {
          await connection.query(
            'UPDATE machines SET status = ? WHERE id = ?',
            [log.status, log.machine_id]
          );
        }
      } else {
        // If it exists but end_time is now closed, update it
        if (log.end_time) {
          await connection.query(
            'UPDATE status_logs SET end_time = ?, downtime_reason = ? WHERE id = ?',
            [new Date(log.end_time), log.downtime_reason, existing[0].id]
          );
        }
      }
    }

    await connection.commit();

    // Trigger OEE recalculation & WebSocket broadcast for affected machines
    const affectedMachineIds = new Set([
      ...pulses.map(p => p.machine_id),
      ...statusLogs.map(l => l.machine_id)
    ]);

    for (const machineId of affectedMachineIds) {
      const oeeMetrics = await calculateOEE(machineId);
      const [machines] = await connection.query(
        'SELECT production_count, good_count, scrap_count, last_pulse, status FROM machines WHERE id = ?',
        [machineId]
      );
      const machineData = machines[0] || {};

      if (wsBroadcastCallback) {
        wsBroadcastCallback({
          type: 'SYNC_UPDATE',
          machineId,
          production_count: machineData.production_count,
          good_count: machineData.good_count,
          scrap_count: machineData.scrap_count,
          last_pulse: machineData.last_pulse,
          status: machineData.status,
          metrics: oeeMetrics
        });
      }
    }

    res.json({ success: true, message: `Successfully synced ${pulses.length} pulses and ${statusLogs.length} logs` });
  } catch (err) {
    await connection.rollback();
    logger.error('Batch Sync Error:', err.message);
    res.status(500).json({ error: 'Failed to synchronize batch payload' });
  } finally {
    connection.release();
  }
});

export default router;
