import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../config/db.js';
import { calculateOEE } from '../services/oeeCalculator.js';
import { handleStatusMessage, handleResumeMessage, publishMQTT } from '../services/mqttService.js';
import { sendSerialCommand } from '../services/serialService.js';
import { resetProductionCounters } from '../services/productionRecordService.js';
import { requireAuth, requireRole, requireSyncKey } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { PREDEFINED_REASONS, REASON_LABELS_MR } from '../config/reasonCodes.js';
import { getShiftForTimestamp, toDateOnlyString, getShiftWindow, SHIFT_NAMES } from '../config/shifts.js';
import { logger } from '../utils/logger.js';
import { withMachineLock } from '../utils/machineLock.js';
import { buildOeeReportRows, buildDowntimeReport, buildHourlyBreakdown, buildPlantSummary } from '../services/reportingService.js';

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
    // Serialized against the watchdog's stale-pulse auto-stop and the sync client's schedule
    // pull so this can never race either of them for the same machine.
    await withMachineLock(machineId, async () => {
      // 1. Trigger physical machine lockout and wait for ESP32 confirmation
      await sendSerialCommand(machineId, 'stop');

      // 2. Only transition database/status after serial confirmation
      await handleStatusMessage(machineId, 'Stopped');
      await recordAuditLog(req.user.loginId, 'MACHINE_STOP', machineId);
    });

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
    // Serialized against the watchdog's stale-pulse auto-stop and the sync client's schedule
    // pull (which is the Edge Gateway's own schedule-presence authority - see
    // syncService.pullMachineConfig) so a Resume can never be undone by either mid-flight.
    let blocked = false;
    await withMachineLock(machineId, async () => {
      // Production must never start without a valid, currently-active part schedule - never
      // fall back to whatever part happened to be active before. On an Edge Gateway this
      // active_schedule_id is a mirror of whatever the Cloud resolved as active (see
      // syncService.pullMachineConfig); on the Cloud/standalone it's set directly by
      // watchdogService's scheduler. Either way, this check and the resume it gates are inside
      // the same lock as the services that clear it, so the read here can never go stale.
      const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machineId]);
      if (machineRows.length === 0) {
        blocked = 'not_found';
        return;
      }
      if (!machineRows[0].active_schedule_id) {
        blocked = 'no_schedule';
        return;
      }

      // 1. Trigger physical machine run enablement and wait for ESP32 confirmation
      await sendSerialCommand(machineId, 'resume');

      // 2. Only transition database/status after serial confirmation
      await handleResumeMessage(machineId, reason, operatorId);
      await recordAuditLog(req.user.loginId, 'MACHINE_RESUME', machineId, reason);
    });

    if (blocked === 'not_found') {
      return res.status(404).json({ error: 'Machine not found' });
    }
    if (blocked === 'no_schedule') {
      return res.status(400).json({ error: 'No part is scheduled. Please schedule the part first from the PPC Engineer login.' });
    }

    res.json({ success: true, message: `CNC Machine ${machineId} resumed in Running state (Confirmed by hardware)` });
  } catch (err) {
    logger.error(`API Error: POST /machines/${machineId}/resume:`, err.message);
    res.status(500).json({ error: `Failed to resume CNC machine: ${err.message}` });
  }
});

/**
 * Fetch logs history for plant management reports.
 * With no filters, keeps the original "last 100 across every machine" quick-glance behavior.
 * When scoped to a machine and/or a plant-timezone-safe [startDate, endDate] day range (via
 * getShiftWindow('Shift C'), the same day-boundary helper the report builders use), the row cap
 * is raised so a specific selection's rows can't silently age out of an unrelated global cap -
 * that gap previously let a real, still-open downtime event (predating whatever's currently
 * "recent" plant-wide) disappear entirely from the Reports Log/Overview bottleneck calculation
 * for a date/machine it actually belongs to.
 */
router.get('/reports', requireAuth, async (req, res) => {
  try {
    const { machineId, startDate, endDate } = req.query;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const conditions = [];
    const params = [];

    if (machineId) {
      conditions.push('sl.machine_id = ?');
      params.push(machineId);
    }

    let scoped = Boolean(machineId);
    if (startDate && endDate && DATE_RE.test(startDate) && DATE_RE.test(endDate)) {
      const rangeStart = getShiftWindow(startDate, 'Shift C').start;
      const rangeEnd = new Date(getShiftWindow(endDate, 'Shift C').start.getTime() + 24 * 3600000);
      conditions.push('sl.start_time < ? AND (sl.end_time IS NULL OR sl.end_time > ?)');
      params.push(rangeEnd, rangeStart);
      scoped = true;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = scoped ? 'LIMIT 2000' : 'LIMIT 100';

    const [reports] = await db.query(`
      SELECT sl.id, sl.machine_id, m.name as machine_name, m.department as machine_section, sl.status, sl.start_time, sl.end_time, sl.downtime_reason, sl.operator_id, sl.part_name
      FROM status_logs sl
      JOIN machines m ON sl.machine_id = m.id
      ${whereClause}
      ORDER BY sl.start_time DESC
      ${limitClause}
    `, params);
    res.json(reports);
  } catch (err) {
    logger.error('API/Reports Error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve reports log' });
  }
});

/**
 * GET /api/reports/plant-summary?date&shift&operator&partName&machineId
 * Plant-wide (or single-machine, via machineId) downtime + OEE summary for one calendar date -
 * the single source of truth behind Overview's "Plant OEE" and "Loss Bottleneck Cause" tiles and
 * the "Export Executive CSV" report. Never computes downtime/OEE itself: see
 * buildPlantSummary() in reportingService.js, which calls the same buildDowntimeReport()/
 * buildOeeReportRows() the Downtime Analysis and OEE Report tabs use directly.
 */
router.get('/reports/plant-summary', requireAuth, async (req, res) => {
  const { date, shift, operator, partName, machineId } = req.query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'Valid date query param (YYYY-MM-DD) is required' });
  }
  if (shift && !SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }

  try {
    const summary = await buildPlantSummary(date, {
      shift: shift || null,
      operator: operator || null,
      partName: partName || null,
      machineId: machineId || null
    });
    res.json(summary);
  } catch (err) {
    logger.error('API Error: GET /reports/plant-summary:', err.message);
    res.status(500).json({ error: 'Failed to build plant summary' });
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
 * GET /api/reports/oee-summary?machineId&startDate&endDate&shift&operator&partName&groupBy
 * Machine-Wise OEE Report: historical Availability/Performance/Quality/OEE (and the expanded
 * KPI set) for an arbitrary date range, optionally scoped to a shift/operator/part. Reuses the
 * exact same formula helpers as the live dashboard (see reportingService.js/oeeCalculator.js) -
 * there is only one OEE calculation in this codebase.
 */
router.get('/reports/oee-summary', requireAuth, async (req, res) => {
  const { machineId, startDate, endDate, shift, operator, partName, groupBy } = req.query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (!machineId) {
    return res.status(400).json({ error: 'machineId is required' });
  }
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return res.status(400).json({ error: 'Valid startDate and endDate query params (YYYY-MM-DD) are required' });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: 'startDate must not be after endDate' });
  }
  if (shift && !SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }

  try {
    const [machines] = await db.query('SELECT id FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      return res.status(404).json({ error: `Machine ${machineId} not found` });
    }

    const effectiveGroupBy = ['day', 'shift'].includes(groupBy) ? groupBy : null;
    const report = await buildOeeReportRows(machineId, startDate, endDate, {
      shift: shift || null,
      operator: operator || null,
      partName: partName || null,
      groupBy: effectiveGroupBy
    });

    res.json(report);
  } catch (err) {
    logger.error('API Error: GET /reports/oee-summary:', err.message);
    res.status(500).json({ error: 'Failed to build OEE report' });
  }
});

/**
 * GET /api/reports/downtime-summary?machineId&startDate&endDate&groupBy&shift&operator&partName
 * Downtime Analysis module: KPIs, grouped totals (day/shift/week/month), and the full flat
 * event list for a machine over a date range, optionally scoped to a shift/operator/part. The
 * frontend filters `events` client-side per group for the "Total Downtime" click-through popup,
 * instead of a separate endpoint.
 */
router.get('/reports/downtime-summary', requireAuth, async (req, res) => {
  const { machineId, startDate, endDate, groupBy, shift, operator, partName } = req.query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (!machineId) {
    return res.status(400).json({ error: 'machineId is required' });
  }
  if (!startDate || !endDate || !DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
    return res.status(400).json({ error: 'Valid startDate and endDate query params (YYYY-MM-DD) are required' });
  }
  if (startDate > endDate) {
    return res.status(400).json({ error: 'startDate must not be after endDate' });
  }
  if (shift && !SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }
  const effectiveGroupBy = ['day', 'shift', 'week', 'month'].includes(groupBy) ? groupBy : 'day';

  try {
    const [machines] = await db.query('SELECT id FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      return res.status(404).json({ error: `Machine ${machineId} not found` });
    }

    const report = await buildDowntimeReport(machineId, startDate, endDate, effectiveGroupBy, {
      shift: shift || null,
      operator: operator || null,
      partName: partName || null
    });
    res.json(report);
  } catch (err) {
    logger.error('API Error: GET /reports/downtime-summary:', err.message);
    res.status(500).json({ error: 'Failed to build downtime report' });
  }
});

/**
 * GET /api/reports/oee-detail?machineId&date&shift
 * "View Details" drill-down for one (machine, date, shift) - a single-row call into the exact
 * same buildOeeReportRows() used by /reports/oee-summary (includeRaw=true so the raw pulses/
 * statusLogs come along for the cycle-time trend, hourly production, reject history, and
 * status/downtime timeline). No separate calculation path.
 */
router.get('/reports/oee-detail', requireAuth, async (req, res) => {
  const { machineId, date, shift } = req.query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (!machineId) {
    return res.status(400).json({ error: 'machineId is required' });
  }
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'A valid date query param (YYYY-MM-DD) is required' });
  }
  if (!shift || !SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }

  try {
    const [machines] = await db.query('SELECT id FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      return res.status(404).json({ error: `Machine ${machineId} not found` });
    }

    const report = await buildOeeReportRows(machineId, date, date, { shift, groupBy: 'shift', includeRaw: true });
    const row = report.rows[0] || null;

    res.json({ machineId, machineName: report.machineName, date, shift, row });
  } catch (err) {
    logger.error('API Error: GET /reports/oee-detail:', err.message);
    res.status(500).json({ error: 'Failed to build OEE detail' });
  }
});

/**
 * GET /api/reports/hourly-breakdown?machineId&date&shift - the Analytics module's "Hourly
 * Production & OEE Trend" chart data source. See buildHourlyBreakdown for the full formula.
 */
router.get('/reports/hourly-breakdown', requireAuth, async (req, res) => {
  const { machineId, date, shift } = req.query;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  if (!machineId) {
    return res.status(400).json({ error: 'machineId is required' });
  }
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'A valid date query param (YYYY-MM-DD) is required' });
  }
  if (!shift || !SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }

  try {
    const [machines] = await db.query('SELECT id, name FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      return res.status(404).json({ error: `Machine ${machineId} not found` });
    }

    const breakdown = await buildHourlyBreakdown(machineId, date, shift);
    res.json({ ...breakdown, machineName: machines[0].name });
  } catch (err) {
    logger.error('API Error: GET /reports/hourly-breakdown:', err.message);
    res.status(500).json({ error: 'Failed to build hourly breakdown' });
  }
});

/**
 * Machine Management CRUD (Admin only) - lets the plant add/edit/remove physical machines
 * without editing source code or re-running the seed script.
 */
router.post('/machines', requireAuth, requireRole('Admin'), async (req, res) => {
  const { id, name, department, target, ideal_cycle_time, active_part_name, assigned_operator, iot_enabled } = req.body;

  if (!id || !name || !department) {
    return res.status(400).json({ error: 'id, name, and department are required' });
  }

  try {
    const [existing] = await db.query('SELECT id FROM machines WHERE id = ?', [id]);
    if (existing.length > 0) {
      return res.status(409).json({ error: `Machine ${id} already exists` });
    }

    // iot_enabled defaults FALSE - a newly-registered machine has no confirmed physical
    // ESP32/Raspberry Pi wiring yet, so it must start as "Not Connected" until an Admin flips
    // this on (see watchdogService.js's per-tick connectivity enforcement).
    await db.query(
      'INSERT INTO machines (id, name, department, target, ideal_cycle_time, active_part_name, assigned_operator, iot_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id.trim(), name.trim(), department.trim(), parseInt(target) || 500, parseInt(ideal_cycle_time) || 15, active_part_name || 'Unassigned', assigned_operator || 'Unassigned', Boolean(iot_enabled)]
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
  const { name, department, target, ideal_cycle_time, iot_enabled } = req.body;

  if (!name || !department || target === undefined || ideal_cycle_time === undefined) {
    return res.status(400).json({ error: 'name, department, target, and ideal_cycle_time are required' });
  }

  try {
    await db.query(
      'UPDATE machines SET name = ?, department = ?, target = ?, ideal_cycle_time = ?, iot_enabled = ? WHERE id = ?',
      [name.trim(), department.trim(), parseInt(target), parseInt(ideal_cycle_time), Boolean(iot_enabled), machineId]
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
 * GET /api/operator-availability?date&shift - who's already assigned to which machine for that
 * (plan_date, shift), across every machine. There is no fixed operator roster - the Supervisor
 * types an operator's name directly into the Assign form each time (creating a full User Profile
 * account per operator isn't realistic on a shop floor), so this endpoint just reflects the
 * part_schedules.operator values already saved, purely so the Supervisor can see who's already
 * taken before typing a name (the actual double-booking rejection still happens server-side in
 * POST /part-schedules/assign-operator, this is only the at-a-glance view).
 */
router.get('/operator-availability', requireAuth, requireRole('Supervisor', 'Admin'), async (req, res) => {
  const { date, shift } = req.query;
  if (!date || !shift) {
    return res.status(400).json({ error: 'date and shift query params are required' });
  }

  try {
    const [entries] = await db.query(
      'SELECT machine_id, operator FROM part_schedules WHERE plan_date = ? AND shift = ? AND operator IS NOT NULL',
      [date, shift]
    );
    const [machines] = await db.query('SELECT id, name FROM machines');
    const machineNameById = new Map(machines.map((m) => [m.id, m.name]));

    // A machine can have several part_schedules entries (multiple parts) in one shift, all
    // assigned the same operator together (see POST /part-schedules/assign-operator below) - any
    // one matching entry is enough to know which machine this operator name is on this shift.
    const seenOperators = new Set();
    const assignments = [];
    entries.forEach((e) => {
      if (seenOperators.has(e.operator)) return;
      seenOperators.add(e.operator);
      assignments.push({
        operatorName: e.operator,
        machineId: e.machine_id,
        machineName: machineNameById.get(e.machine_id) || e.machine_id
      });
    });

    res.json({ date, shift, assignments });
  } catch (err) {
    logger.error('API Error: GET /operator-availability:', err.message);
    res.status(500).json({ error: 'Failed to retrieve operator availability' });
  }
});

/**
 * Downtime reason codes - single source of truth, shared by OEE aggregation and the frontend.
 * Plain GET returns the canonical English values (what every dashboard/report/export renders,
 * and what actually gets stored in status_logs.downtime_reason). ?locale=mr is for the Operator
 * Terminal only: same values, paired with their Marathi display label - the terminal still
 * submits `value` (English) so storage and Cloud-side aggregation never see Marathi text.
 */
router.get('/reason-codes', requireAuth, (req, res) => {
  if (req.query.locale === 'mr') {
    return res.json(PREDEFINED_REASONS.map((value) => ({ value, label: REASON_LABELS_MR[value] || value })));
  }
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

  // CRITICAL FIX: this batch used to write status_logs on a bare transaction with only a
  // "SELECT ... then INSERT if not found" check to avoid duplicates - a classic check-then-act
  // race. Under InnoDB's default REPEATABLE READ isolation, two overlapping /sync/data calls
  // for the same machine (a retried upload, or two overlapping gateway sync ticks) each open
  // their own transaction, each independently see "no matching row yet" (neither can see the
  // other's still-uncommitted insert), and both insert - producing exact duplicate open
  // status_logs rows with identical start_time. This is what put 4 identical 'Running' rows
  // with the same timestamp into the log viewer. Serializing per affected machine through the
  // same withMachineLock every other status_logs writer uses closes that gap; the lock is
  // reentrant, so nesting one call per machine here is safe.
  const machineIds = [...new Set([
    ...pulses.map((p) => p.machine_id),
    ...statusLogs.map((l) => l.machine_id)
  ])];

  const withMachineLocks = (ids, fn) => {
    if (ids.length === 0) return fn();
    const [first, ...rest] = ids;
    return withMachineLock(first, () => withMachineLocks(rest, fn));
  };

  const connection = await db.getConnection();
  try {
    await withMachineLocks(machineIds, async () => {
    await connection.beginTransaction();

    // 1. Process batch pulses
    const latestPulseTimeByMachine = new Map();
    for (const pulse of pulses) {
      const pulseTime = new Date(pulse.timestamp);
      pulseTime.setMilliseconds(0);

      // Track the freshest pulse timestamp per machine in this batch (even for pulses that
      // turn out to be duplicates below) - used after the status log pass to detect a machine
      // the Edge Gateway has proven is actually Running via real telemetry (it never sends a
      // pulse for a machine whose local status is Stopped - see handlePulseMessage) but whose
      // last known status_logs entry on the cloud says otherwise.
      const prevLatest = latestPulseTimeByMachine.get(pulse.machine_id);
      if (!prevLatest || pulseTime.getTime() > prevLatest) {
        latestPulseTimeByMachine.set(pulse.machine_id, pulseTime.getTime());
      }

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
        // CRITICAL FIX: every other place in this codebase that opens a new status_logs row
        // (ensureActiveStatusLog, handleResumeMessage) closes out any OTHER row already open
        // for that machine first - exactly one open row per machine is an invariant the rest of
        // the system depends on. This insert path was the one place that never enforced it: a
        // batch that uploads a still-open segment (endTime === null, normal on every sync cycle
        // until that segment actually closes) that never later gets re-matched by the exact
        // same (machine_id, status, start_time) tuple leaves a PERMANENT orphaned open row on
        // the cloud. These accumulate forever and make the watchdog's stale-pulse LEFT JOIN
        // process the same machine multiple times per tick (see the comment in
        // handleResumeMessage for why that misfires) - a real, confirmed cause of erratic
        // "Not Connected" behavior on an actively-producing machine.
        if (endTime === null) {
          await connection.query(
            'UPDATE status_logs SET end_time = ?, synced = TRUE WHERE machine_id = ? AND end_time IS NULL',
            [startTime, log.machine_id]
          );
        }
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

    // Set each affected machine's current status from whichever status_logs row is
    // chronologically latest, rather than only reacting to rows that happen to still be open
    // at upload time. The gateway's 5-second sync loop can easily batch a status transition
    // that's already closed by the time it uploads (two quick transitions inside one window),
    // which used to leave machines.status stuck on a stale value indefinitely - deriving it
    // from the latest row after every batch is self-correcting regardless of that timing race.
    const machinesWithStatusLogs = new Set(statusLogs.map((l) => l.machine_id));
    for (const machineId of machinesWithStatusLogs) {
      const [[latest]] = await connection.query(
        'SELECT status FROM status_logs WHERE machine_id = ? ORDER BY start_time DESC, id DESC LIMIT 1',
        [machineId]
      );
      if (latest) {
        await connection.query('UPDATE machines SET status = ? WHERE id = ?', [latest.status, machineId]);
      }
    }

    // Self-heal a machine the cloud believes is Stopped/Not Connected but that just proved via a
    // real pulse it's actually Running - this is what recovers a machine from a false auto-stop
    // the Cloud's own watchdog previously wrote (see watchdogService.js: the Cloud has no
    // low-latency signal of its own and used to force machines.status to Stopped purely because
    // sync had lagged, leaving a phantom Stopped status_logs row that nothing ever corrected,
    // since the Edge Gateway only re-uploads a status row on a *real* transition - which a
    // machine that never actually stopped will never produce). A pulse timestamped after the
    // latest known status_logs row is only possible if that row is stale/wrong: the Edge Gateway
    // refuses to emit pulses at all while its own local status is Stopped, so this pulse is
    // proof positive the machine was Running at a time the cloud didn't yet know about.
    for (const [machineId, latestPulseTime] of latestPulseTimeByMachine) {
      const [[machineRow]] = await connection.query('SELECT status FROM machines WHERE id = ?', [machineId]);
      if (!machineRow || machineRow.status === 'Running') continue;

      const [[latestLog]] = await connection.query(
        'SELECT status, start_time FROM status_logs WHERE machine_id = ? ORDER BY start_time DESC, id DESC LIMIT 1',
        [machineId]
      );
      if (latestLog && latestLog.status === 'Running') continue;
      if (latestLog && latestPulseTime <= new Date(latestLog.start_time).getTime()) continue;

      const reconciledAt = new Date(latestPulseTime);
      await connection.query(
        'UPDATE status_logs SET end_time = ? WHERE machine_id = ? AND end_time IS NULL',
        [reconciledAt, machineId]
      );
      await connection.query(
        "INSERT INTO status_logs (machine_id, status, start_time, end_time) VALUES (?, 'Running', ?, NULL)",
        [machineId, reconciledAt]
      );
      await connection.query("UPDATE machines SET status = 'Running' WHERE id = ?", [machineId]);
      logger.warn(`🔄 Sync: Machine ${machineId} received a pulse newer than its last known status change (cloud had it as "${machineRow.status}") - reconciling to Running.`);
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
    });
  } catch (err) {
    await connection.rollback();
    logger.error('Batch Sync Error:', err.message);
    res.status(500).json({ error: 'Failed to synchronize batch payload' });
  } finally {
    connection.release();
  }
});

export default router;
