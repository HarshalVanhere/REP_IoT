import express from 'express';
import db from '../config/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { logger } from '../utils/logger.js';
import { activateScheduleEntry } from '../services/partScheduleService.js';
import { SHIFT_NAMES, getShiftForTimestamp, toDateOnlyString } from '../config/shifts.js';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function isCurrentDateShift(planDate, shift) {
  return planDate === toDateOnlyString() && shift === getShiftForTimestamp(new Date());
}

/**
 * Actual production for one scheduled entry, attributed via pulses.part_schedule_id (stamped
 * at ingest time) rather than a time-window join - correct even when a manual override or a
 * forced end-time cutover makes real execution diverge from the planned start/end window.
 */
async function computeActualForEntry(scheduleId) {
  const [pulses] = await db.query('SELECT is_good FROM pulses WHERE part_schedule_id = ?', [scheduleId]);
  const good = pulses.filter((p) => p.is_good === 1 || p.is_good === true).length;
  return { count: pulses.length, good, scrap: pulses.length - good };
}

/**
 * GET /api/part-schedules?date=YYYY-MM-DD
 * Every machine x shift for the date, each with its ordered list of scheduled part entries.
 */
router.get('/', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'A valid date query param (YYYY-MM-DD) is required' });
  }

  try {
    const [machines] = await db.query('SELECT id, name, active_schedule_id FROM machines');
    const [entries] = await db.query(
      'SELECT * FROM part_schedules WHERE plan_date = ? ORDER BY sequence ASC',
      [date]
    );

    const rows = [];
    for (const machine of machines) {
      for (const shift of SHIFT_NAMES) {
        const shiftEntries = entries.filter((e) => e.machine_id === machine.id && e.shift === shift);
        const entriesWithActual = await Promise.all(
          shiftEntries.map(async (e) => ({
            id: e.id,
            sequence: e.sequence,
            part_name: e.part_name,
            target: e.target,
            ideal_cycle_time: e.ideal_cycle_time,
            operator: e.operator,
            planned_start: e.planned_start,
            planned_end: e.planned_end,
            status: e.status,
            isActive: machine.active_schedule_id === e.id,
            actual: await computeActualForEntry(e.id)
          }))
        );
        rows.push({ machineId: machine.id, machineName: machine.name, shift, entries: entriesWithActual });
      }
    }

    res.json({ date, editable: date >= toDateOnlyString(), rows });
  } catch (err) {
    logger.error('API Error: GET /part-schedules:', err.message);
    res.status(500).json({ error: 'Failed to retrieve part schedules' });
  }
});

/**
 * POST /api/part-schedules - appends one entry to the end of a (machine, date, shift)'s
 * sequence. If this is the very first entry for a currently-active shift, activates it
 * immediately (mirrors the old single-plan model's "applies live if current" behavior).
 */
router.post('/', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const { machine_id, plan_date, shift, part_name, target, ideal_cycle_time, operator, planned_start, planned_end } = req.body;

  if (!machine_id || !plan_date || !shift || !part_name || target === undefined || ideal_cycle_time === undefined || !planned_start || !planned_end) {
    return res.status(400).json({ error: 'machine_id, plan_date, shift, part_name, target, ideal_cycle_time, planned_start, and planned_end are required' });
  }
  if (!DATE_RE.test(plan_date)) {
    return res.status(400).json({ error: 'plan_date must be in YYYY-MM-DD format' });
  }
  if (!SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }
  if (plan_date < toDateOnlyString()) {
    return res.status(400).json({ error: 'Cannot create a schedule entry for a past date' });
  }
  if (!TIME_RE.test(planned_start) || !TIME_RE.test(planned_end)) {
    return res.status(400).json({ error: 'planned_start and planned_end must be in HH:MM format' });
  }

  const numTarget = parseInt(target);
  const numCycle = parseInt(ideal_cycle_time);
  if (isNaN(numTarget) || isNaN(numCycle)) {
    return res.status(400).json({ error: 'target and ideal_cycle_time must be valid numbers' });
  }

  try {
    const [existing] = await db.query(
      'SELECT COALESCE(MAX(sequence), 0) as maxSeq FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [machine_id, plan_date, shift]
    );
    const nextSequence = existing[0].maxSeq + 1;

    const [result] = await db.query(
      `INSERT INTO part_schedules
        (machine_id, plan_date, shift, sequence, part_name, target, ideal_cycle_time, operator, planned_start, planned_end, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
      [machine_id, plan_date, shift, nextSequence, part_name, numTarget, numCycle, operator || null, planned_start, planned_end, req.user.loginId, req.user.loginId]
    );
    const scheduleId = result.insertId;

    // First entry of a currently-active shift with nothing else running yet - activate now.
    if (nextSequence === 1 && isCurrentDateShift(plan_date, shift)) {
      const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machine_id]);
      if (machineRows.length > 0 && !machineRows[0].active_schedule_id) {
        await activateScheduleEntry(machine_id, {
          id: scheduleId, part_name, target: numTarget, ideal_cycle_time: numCycle, operator
        }, { changedBy: req.user.loginId, changeTrigger: 'manual_override', changeReason: 'First scheduled part activated on creation' });
      }
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_CREATE', `${machine_id}/${plan_date}/${shift}`, `#${nextSequence} ${part_name} (target=${numTarget})`);

    res.json({ success: true, message: 'Part schedule entry created', id: scheduleId });
  } catch (err) {
    logger.error('API Error: POST /part-schedules:', err.message);
    res.status(500).json({ error: 'Failed to create part schedule entry' });
  }
});

/**
 * PUT /api/part-schedules/:id - edits an entry's target/cycle-time/operator/timing.
 * Renaming the part itself is disallowed (delete + recreate instead) so a live in-progress
 * run's identity can't silently change underneath its own production history.
 */
router.put('/:id', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { part_name, target, ideal_cycle_time, operator, planned_start, planned_end } = req.body;

  if (target === undefined || ideal_cycle_time === undefined || !planned_start || !planned_end) {
    return res.status(400).json({ error: 'target, ideal_cycle_time, planned_start, and planned_end are required' });
  }
  const numTarget = parseInt(target);
  const numCycle = parseInt(ideal_cycle_time);
  if (isNaN(numTarget) || isNaN(numCycle)) {
    return res.status(400).json({ error: 'target and ideal_cycle_time must be valid numbers' });
  }
  if (!TIME_RE.test(planned_start) || !TIME_RE.test(planned_end)) {
    return res.status(400).json({ error: 'planned_start and planned_end must be in HH:MM format' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM part_schedules WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Part schedule entry not found' });
    }
    const entry = rows[0];

    if (entry.plan_date < toDateOnlyString()) {
      return res.status(403).json({ error: 'This entry is in the past and can no longer be edited' });
    }
    if (part_name && part_name !== entry.part_name) {
      return res.status(400).json({ error: 'Renaming a scheduled part is not allowed - delete this entry and create a new one instead' });
    }

    await db.query(
      'UPDATE part_schedules SET target = ?, ideal_cycle_time = ?, operator = ?, planned_start = ?, planned_end = ?, updated_by = ? WHERE id = ?',
      [numTarget, numCycle, operator || null, planned_start, planned_end, req.user.loginId, id]
    );

    // If this entry is the one currently live, push the edited target/cycle/operator onto
    // the machine immediately - it's the same part continuing, so nothing resets.
    if (entry.status === 'Running') {
      await db.query(
        'UPDATE machines SET target = ?, ideal_cycle_time = ?, assigned_operator = ? WHERE id = ? AND active_schedule_id = ?',
        [numTarget, numCycle, operator || 'Unassigned', entry.machine_id, id]
      );
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_UPDATE', `${entry.machine_id}/${entry.plan_date}/${entry.shift}`, `#${entry.sequence} ${entry.part_name} (target=${numTarget})`);

    res.json({ success: true, message: 'Part schedule entry updated' });
  } catch (err) {
    logger.error(`API Error: PUT /part-schedules/${id}:`, err.message);
    res.status(500).json({ error: 'Failed to update part schedule entry' });
  }
});

/**
 * DELETE /api/part-schedules/:id - only Pending entries (Running/Completed carry real
 * production history and can't be removed). Renumbers the remaining sequence.
 */
router.delete('/:id', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const id = parseInt(req.params.id);

  try {
    const [rows] = await db.query('SELECT * FROM part_schedules WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Part schedule entry not found' });
    }
    const entry = rows[0];
    if (entry.status !== 'Pending') {
      return res.status(400).json({ error: `Cannot delete a "${entry.status}" entry - only Pending entries can be removed` });
    }

    await db.query('DELETE FROM part_schedules WHERE id = ?', [id]);

    const [remaining] = await db.query(
      'SELECT id FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ? AND sequence > ? ORDER BY sequence ASC',
      [entry.machine_id, entry.plan_date, entry.shift, entry.sequence]
    );
    for (let i = 0; i < remaining.length; i++) {
      await db.query('UPDATE part_schedules SET sequence = ? WHERE id = ?', [entry.sequence + i, remaining[i].id]);
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_DELETE', `${entry.machine_id}/${entry.plan_date}/${entry.shift}`, `#${entry.sequence} ${entry.part_name}`);

    res.json({ success: true, message: 'Part schedule entry deleted' });
  } catch (err) {
    logger.error(`API Error: DELETE /part-schedules/${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Failed to delete part schedule entry' });
  }
});

/**
 * POST /api/part-schedules/reorder - renumbers a (machine, date, shift) group's sequence to
 * match `orderedIds`. Intended for Pending entries only (drag-and-drop reordering on the
 * Planning Board) - already-Running/Completed entries keep their historical position.
 */
router.post('/reorder', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const { machine_id, plan_date, shift, orderedIds } = req.body;

  if (!machine_id || !plan_date || !shift || !Array.isArray(orderedIds) || orderedIds.length === 0) {
    return res.status(400).json({ error: 'machine_id, plan_date, shift, and a non-empty orderedIds array are required' });
  }
  if (plan_date < toDateOnlyString()) {
    return res.status(400).json({ error: 'Cannot reorder a past date' });
  }

  try {
    const [entries] = await db.query(
      'SELECT id, status FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [machine_id, plan_date, shift]
    );
    const pendingIds = new Set(entries.filter((e) => e.status === 'Pending').map((e) => e.id));
    const alreadyStarted = entries.filter((e) => e.status !== 'Pending');
    const startingSequence = alreadyStarted.length + 1;

    let seq = startingSequence;
    for (const id of orderedIds) {
      if (!pendingIds.has(id)) continue; // ignore ids that aren't Pending (or don't belong here)
      await db.query('UPDATE part_schedules SET sequence = ? WHERE id = ?', [seq, id]);
      seq++;
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_REORDER', `${machine_id}/${plan_date}/${shift}`, `${orderedIds.length} entries reordered`);

    res.json({ success: true, message: 'Part schedule reordered' });
  } catch (err) {
    logger.error('API Error: POST /part-schedules/reorder:', err.message);
    res.status(500).json({ error: 'Failed to reorder part schedule' });
  }
});

/**
 * POST /api/part-schedules/copy-day - copies every machine/shift's whole ordered entry list
 * from sourceDate onto targetDate (append, not upsert - targetDate is assumed empty for the
 * shifts being copied). Used by the "Copy Previous Day" button.
 */
router.post('/copy-day', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const { sourceDate, targetDate } = req.body;

  if (!sourceDate || !targetDate || !DATE_RE.test(sourceDate) || !DATE_RE.test(targetDate)) {
    return res.status(400).json({ error: 'sourceDate and targetDate (YYYY-MM-DD) are required' });
  }
  if (targetDate < toDateOnlyString()) {
    return res.status(400).json({ error: 'Cannot copy a schedule onto a past date' });
  }

  try {
    const [sourceEntries] = await db.query('SELECT * FROM part_schedules WHERE plan_date = ? ORDER BY sequence ASC', [sourceDate]);
    if (sourceEntries.length === 0) {
      return res.status(404).json({ error: `No scheduled parts found on ${sourceDate} to copy` });
    }

    let copied = 0;
    for (const source of sourceEntries) {
      const [existing] = await db.query(
        'SELECT id FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ? AND sequence = ?',
        [source.machine_id, targetDate, source.shift, source.sequence]
      );
      if (existing.length > 0) continue; // already copied / already exists at this slot

      await db.query(
        `INSERT INTO part_schedules
          (machine_id, plan_date, shift, sequence, part_name, target, ideal_cycle_time, operator, planned_start, planned_end, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
        [
          source.machine_id, targetDate, source.shift, source.sequence, source.part_name, source.target, source.ideal_cycle_time,
          source.operator, source.planned_start, source.planned_end, req.user.loginId, req.user.loginId
        ]
      );
      copied++;
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_COPY', `${sourceDate} -> ${targetDate}`, `${copied} entries copied`);

    res.json({ success: true, message: `Copied ${copied} scheduled part(s) from ${sourceDate} to ${targetDate}` });
  } catch (err) {
    logger.error('API Error: POST /part-schedules/copy-day:', err.message);
    res.status(500).json({ error: 'Failed to copy part schedule' });
  }
});

/**
 * POST /api/part-schedules/:machineId/activate - PPC Engineer mid-shift override: jump to
 * any scheduled entry for today's current shift immediately, regardless of sequence order.
 */
router.post('/:machineId/activate', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const machineId = req.params.machineId;
  const { scheduleId, reason } = req.body;

  if (!scheduleId) {
    return res.status(400).json({ error: 'scheduleId is required' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM part_schedules WHERE id = ?', [scheduleId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Part schedule entry not found' });
    }
    const entry = rows[0];

    if (entry.machine_id !== machineId) {
      return res.status(400).json({ error: 'That schedule entry does not belong to this machine' });
    }
    if (!isCurrentDateShift(entry.plan_date, entry.shift)) {
      return res.status(400).json({ error: 'Can only activate an entry scheduled for the current shift' });
    }
    if (entry.status === 'Completed') {
      return res.status(400).json({ error: 'Cannot re-activate a completed entry' });
    }

    await activateScheduleEntry(machineId, entry, {
      changedBy: req.user.loginId,
      changeTrigger: 'manual_override',
      changeReason: reason || null
    });

    res.json({ success: true, message: `Activated "${entry.part_name}" on machine ${machineId}` });
  } catch (err) {
    logger.error(`API Error: POST /part-schedules/${machineId}/activate:`, err.message);
    res.status(500).json({ error: `Failed to activate part schedule: ${err.message}` });
  }
});

export default router;
