import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../config/db.js';
import { calculateOEE } from '../services/oeeCalculator.js';
import { handleStatusMessage, handleResumeMessage, publishMQTT } from '../services/mqttService.js';
import { sendSerialCommand } from '../services/serialService.js';
import { resetProductionCounters } from '../services/productionRecordService.js';
import { requireAuth, requireRole, requireSyncKey } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { PREDEFINED_REASONS } from '../config/reasonCodes.js';
import { getShiftForTimestamp, toDateOnlyString } from '../config/shifts.js';
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
 * Manually reset a machine's live production counters (Supervisor/Admin only, emergency use).
 * Closes out the current tally as a production_records entry (reason: manual_reset) before
 * zeroing the counters, so nothing is lost - just moved into history.
 */
router.post('/machines/:id/reset-count', requireAuth, requireRole('Supervisor', 'Admin'), async (req, res) => {
  const machineId = req.params.id;
  try {
    await resetProductionCounters(machineId, 'manual_reset', req.user.loginId);
    // Stamped so the edge gateway's sync loop can tell a reset happened and mirror it onto
    // its own local counters - without this, a cloud-triggered reset only ever affects the
    // cloud's mirror of the count, since the gateway is what actually increments it live.
    await db.query('UPDATE machines SET last_manual_reset_at = NOW() WHERE id = ?', [machineId]);
    await recordAuditLog(req.user.loginId, 'MACHINE_COUNT_RESET', machineId);
    res.json({ success: true, message: `Production counters reset for machine ${machineId}` });
  } catch (err) {
    logger.error(`API Error: POST /machines/${machineId}/reset-count:`, err.message);
    res.status(500).json({ error: `Failed to reset counters: ${err.message}` });
  }
});

/**
 * Retrieve this machine's closed-out production history (each part/shift run that was
 * reset), most recent first.
 */
router.get('/machines/:id/production-records', requireAuth, async (req, res) => {
  const machineId = req.params.id;
  try {
    const [records] = await db.query(
      'SELECT * FROM production_records WHERE machine_id = ? ORDER BY end_time DESC LIMIT 100',
      [machineId]
    );
    res.json(records);
  } catch (err) {
    logger.error(`API Error: GET /machines/${machineId}/production-records:`, err.message);
    res.status(500).json({ error: 'Failed to retrieve production records' });
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
    // Production must never start without a valid, currently-active part schedule - never
    // fall back to whatever part happened to be active before. See watchdogService.js's
    // blockMachineWithoutSchedule() for the counterpart that clears this when a shift/schedule
    // ends without a replacement.
    const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machineId]);
    if (machineRows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    if (!machineRows[0].active_schedule_id) {
      return res.status(400).json({ error: 'No part is scheduled. Please schedule the part first from the PPC Engineer login.' });
    }

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
 * GET /api/reports/production-summary?date=YYYY-MM-DD&groupBy=part|shift|machine
 * Aggregates closed-out part/shift runs from production_records for the given date, grouped
 * by part/shift/machine as requested, plus each machine's still-in-progress (not yet closed)
 * tally when the date is today - so a run that hasn't ended yet still counts toward the total.
 */
router.get('/reports/production-summary', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'A valid date query param (YYYY-MM-DD) is required' });
  }
  const groupBy = ['part', 'shift', 'machine'].includes(req.query.groupBy) ? req.query.groupBy : 'part';

  try {
    const [allRecords] = await db.query('SELECT * FROM production_records');
    const [machines] = await db.query('SELECT id, name FROM machines');
    const machineNameById = Object.fromEntries(machines.map((m) => [m.id, m.name]));

    const dayRows = allRecords
      .filter((r) => toDateOnlyString(r.start_time) === date || toDateOnlyString(r.end_time) === date)
      .map((r) => ({
        machine_id: r.machine_id,
        machine_name: machineNameById[r.machine_id] || r.machine_id,
        part_name: r.part_name || 'Unassigned',
        shift: r.shift || 'Unknown',
        target: r.target || 0,
        production_count: r.production_count || 0,
        good_count: r.good_count || 0,
        scrap_count: r.scrap_count || 0
      }));

    // Still-running (not yet closed) tallies count toward today's totals too.
    if (date === toDateOnlyString()) {
      const [liveMachines] = await db.query(
        'SELECT id, name, active_part_name, target, production_count, good_count, scrap_count FROM machines WHERE production_count > 0'
      );
      for (const m of liveMachines) {
        dayRows.push({
          machine_id: m.id,
          machine_name: m.name,
          part_name: m.active_part_name || 'Unassigned',
          shift: getShiftForTimestamp(new Date()),
          target: m.target || 0,
          production_count: m.production_count || 0,
          good_count: m.good_count || 0,
          scrap_count: m.scrap_count || 0
        });
      }
    }

    const keyOf = (row) => (groupBy === 'part' ? row.part_name : groupBy === 'shift' ? row.shift : row.machine_name);

    const groups = new Map();
    for (const row of dayRows) {
      const key = keyOf(row);
      if (!groups.has(key)) {
        groups.set(key, { key, target: 0, production_count: 0, good_count: 0, scrap_count: 0 });
      }
      const g = groups.get(key);
      g.target += row.target;
      g.production_count += row.production_count;
      g.good_count += row.good_count;
      g.scrap_count += row.scrap_count;
    }

    res.json({ date, groupBy, rows: Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key)) });
  } catch (err) {
    logger.error('API Error: GET /reports/production-summary:', err.message);
    res.status(500).json({ error: 'Failed to retrieve production summary' });
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
 * Edge Gateway pulls its own machine's live planning config (target, ideal cycle time,
 * part, operator) down from the cloud DB. This is the missing downward counterpart to
 * POST /sync/data below - that route only ever uploads pulses/status logs, so without this,
 * a shift plan edited on the cloud dashboard updates the cloud's copy of the machine row but
 * never reaches the gateway's own local DB (they only talk to each other through this sync
 * loop, not a shared database).
 */
router.get('/sync/machine-config/:machineId', requireSyncKey, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, target, ideal_cycle_time, active_part_name, assigned_operator, active_schedule_id, last_manual_reset_at FROM machines WHERE id = ?',
      [req.params.machineId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Machine not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    logger.error(`API Error: GET /sync/machine-config/${req.params.machineId}:`, err.message);
    res.status(500).json({ error: 'Failed to fetch machine config' });
  }
});

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
      const pulseTime = new Date(pulse.timestamp);
      pulseTime.setMilliseconds(0);

      // Check if pulse already exists in cloud DB to prevent duplication
      const [existing] = await connection.query(
        'SELECT id FROM pulses WHERE machine_id = ? AND timestamp = ? AND cycle_time = ?',
        [pulse.machine_id, pulseTime, pulse.cycle_time]
      );

      if (existing.length === 0) {
        // Insert pulse. part_schedule_id rides through as-is - it's the cloud's own schedule
        // id in the first place (the gateway has no schedule table of its own, it only ever
        // mirrors whichever entry the cloud already resolved as active via pullMachineConfig).
        await connection.query(
          'INSERT INTO pulses (machine_id, timestamp, cycle_time, is_good, part_schedule_id, synced) VALUES (?, ?, ?, ?, ?, TRUE)',
          [pulse.machine_id, pulseTime, pulse.cycle_time, pulse.is_good, pulse.part_schedule_id || null]
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
          [pulseTime, pulse.machine_id]
        );
      }
    }

    // 2. Process batch status logs
    for (const log of statusLogs) {
      const startTime = new Date(log.start_time);
      startTime.setMilliseconds(0);
      const endTime = log.end_time ? new Date(log.end_time) : null;
      if (endTime) endTime.setMilliseconds(0);

      // Check if log already exists in cloud DB
      const [existing] = await connection.query(
        'SELECT id FROM status_logs WHERE machine_id = ? AND status = ? AND start_time = ?',
        [log.machine_id, log.status, startTime]
      );

      if (existing.length === 0) {
        await connection.query(
          'INSERT INTO status_logs (machine_id, status, start_time, end_time, downtime_reason, operator_id, part_name, synced) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)',
          [
            log.machine_id,
            log.status,
            startTime,
            endTime,
            log.downtime_reason,
            log.operator_id,
            log.part_name
          ]
        );

        // Update the machine's current status if this log is active (end_time is null) or newer
        if (!endTime) {
          await connection.query(
            'UPDATE machines SET status = ? WHERE id = ?',
            [log.status, log.machine_id]
          );
        }
      } else {
        // If it exists but end_time is now closed, update it
        if (endTime) {
          await connection.query(
            'UPDATE status_logs SET end_time = ?, downtime_reason = ? WHERE id = ?',
            [endTime, log.downtime_reason, existing[0].id]
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
