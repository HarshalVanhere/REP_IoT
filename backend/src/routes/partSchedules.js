import express from 'express';
import db from '../config/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { logger } from '../utils/logger.js';
import { activateScheduleEntry } from '../services/partScheduleService.js';
import { SHIFT_NAMES, getShiftForTimestamp, toDateOnlyString } from '../config/shifts.js';
import { calculateAutoTarget } from '../services/oeeCalculator.js';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

function isCurrentDateShift(planDate, shift) {
  return planDate === toDateOnlyString() && shift === getShiftForTimestamp(new Date());
}

/**
 * Validates the manually-entered Ideal Cycle Time / Loading-Unloading Allowance and computes the
 * automatic target for a [planned_start, planned_end) window. Returns { idealCycleTime,
 * allowanceSeconds, targetResult } or throws an Error with a `.status` the caller can turn
 * straight into an HTTP response - the single choke-point POST, PUT, and preview-target all call,
 * so the three can never compute a target differently.
 *
 * There is no Part Master catalog and no Admin-configured default allowance - the PPC Engineer
 * types Part Number, Part Name, Part Operation, Ideal Cycle Time, and the Loading/Unloading
 * Allowance directly on every entry. Target is still always server-computed, never accepted from
 * the request body - only its two inputs (cycle time, allowance) are now manually typed instead
 * of resolved from a catalog/settings lookup.
 */
function resolveAutoTarget(idealCycleTime, loadUnloadAllowanceSeconds, planDate, plannedStart, plannedEnd) {
  const numCycle = parseInt(idealCycleTime);
  const numAllowance = parseInt(loadUnloadAllowanceSeconds);
  if (isNaN(numCycle) || numCycle <= 0) {
    const err = new Error('ideal_cycle_time must be a positive number');
    err.status = 400;
    throw err;
  }
  if (isNaN(numAllowance) || numAllowance < 0) {
    const err = new Error('load_unload_allowance_seconds must be a non-negative number');
    err.status = 400;
    throw err;
  }

  const targetResult = calculateAutoTarget({
    planDate,
    plannedStart,
    plannedEnd,
    idealCycleTime: numCycle,
    loadUnloadAllowanceSeconds: numAllowance
  });

  return { idealCycleTime: numCycle, allowanceSeconds: numAllowance, targetResult };
}

/**
 * GET /api/part-schedules/preview-target - live "Auto Target: N parts" preview for the Planning
 * Board modal, called as the PPC Engineer types Ideal Cycle Time / Allowance / adjusts the
 * planned window, before saving. Uses the exact same resolveAutoTarget() the POST/PUT routes use
 * below, so the preview can never drift from what actually gets saved.
 */
router.get('/preview-target', requireAuth, async (req, res) => {
  const { planDate, plannedStart, plannedEnd, idealCycleTime, loadUnloadAllowanceSeconds } = req.query;

  if (!planDate || !plannedStart || !plannedEnd || idealCycleTime === undefined || loadUnloadAllowanceSeconds === undefined) {
    return res.status(400).json({ error: 'planDate, plannedStart, plannedEnd, idealCycleTime, and loadUnloadAllowanceSeconds are required' });
  }
  if (!DATE_RE.test(planDate)) {
    return res.status(400).json({ error: 'planDate must be in YYYY-MM-DD format' });
  }
  if (!TIME_RE.test(plannedStart) || !TIME_RE.test(plannedEnd)) {
    return res.status(400).json({ error: 'plannedStart and plannedEnd must be in HH:MM format' });
  }

  try {
    const { targetResult } = resolveAutoTarget(idealCycleTime, loadUnloadAllowanceSeconds, planDate, plannedStart, plannedEnd);
    res.json(targetResult);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('API Error: GET /part-schedules/preview-target:', err.message);
    res.status(500).json({ error: 'Failed to compute target preview' });
  }
});

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
            part_number: e.part_number,
            part_operation: e.part_operation,
            target: e.target,
            ideal_cycle_time: e.ideal_cycle_time,
            load_unload_allowance_seconds: e.load_unload_allowance_seconds,
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
  // Target is never accepted from the request body - always server-computed from the manually
  // entered ideal_cycle_time/load_unload_allowance_seconds. Operator assignment belongs
  // exclusively to the Supervisor's endpoint, never to PPC's create/edit flow.
  const {
    machine_id, plan_date, shift, part_number, part_name, part_operation,
    ideal_cycle_time, load_unload_allowance_seconds, planned_start, planned_end
  } = req.body;

  if (!machine_id || !plan_date || !shift || !part_number || !part_name
    || ideal_cycle_time === undefined || load_unload_allowance_seconds === undefined
    || !planned_start || !planned_end) {
    return res.status(400).json({
      error: 'machine_id, plan_date, shift, part_number, part_name, ideal_cycle_time, load_unload_allowance_seconds, planned_start, and planned_end are required'
    });
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

  try {
    const { idealCycleTime, allowanceSeconds, targetResult } = resolveAutoTarget(
      ideal_cycle_time, load_unload_allowance_seconds, plan_date, planned_start, planned_end
    );
    const numTarget = targetResult.target;

    const [existing] = await db.query(
      'SELECT COALESCE(MAX(sequence), 0) as maxSeq FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [machine_id, plan_date, shift]
    );
    const nextSequence = existing[0].maxSeq + 1;

    const [result] = await db.query(
      `INSERT INTO part_schedules
        (machine_id, plan_date, shift, sequence, part_name, part_number, part_operation, target, ideal_cycle_time, load_unload_allowance_seconds, planned_start, planned_end, status, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
      [machine_id, plan_date, shift, nextSequence, part_name.trim(), part_number.trim(), part_operation?.trim() || null, numTarget, idealCycleTime, allowanceSeconds, planned_start, planned_end, req.user.loginId, req.user.loginId]
    );
    const scheduleId = result.insertId;

    // First entry of a currently-active shift with nothing else running yet - activate now.
    if (nextSequence === 1 && isCurrentDateShift(plan_date, shift)) {
      const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machine_id]);
      if (machineRows.length > 0 && !machineRows[0].active_schedule_id) {
        await activateScheduleEntry(machine_id, {
          id: scheduleId, part_name: part_name.trim(), target: numTarget, ideal_cycle_time: idealCycleTime, operator: null
        }, { changedBy: req.user.loginId, changeTrigger: 'manual_override', changeReason: 'First scheduled part activated on creation' });
      }
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_CREATE', `${machine_id}/${plan_date}/${shift}`, `#${nextSequence} ${part_name} (auto target=${numTarget})`);

    res.json({ success: true, message: 'Part schedule entry created', id: scheduleId, target: numTarget });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error('API Error: POST /part-schedules:', err.message);
    res.status(500).json({ error: 'Failed to create part schedule entry' });
  }
});

/**
 * PUT /api/part-schedules/:id - edits an entry. Target is always recomputed from the manually
 * entered ideal_cycle_time/load_unload_allowance_seconds, never accepted from the request body.
 * Changing part_number/part_name is disallowed (delete + recreate instead) so a live in-progress
 * run's identity can't silently change underneath its own production history - Ideal Cycle Time,
 * Allowance, Part Operation, and the planned window ARE editable. Operator is never touched here
 * - see assign-operator.
 */
router.put('/:id', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { part_number, part_name, part_operation, ideal_cycle_time, load_unload_allowance_seconds, planned_start, planned_end } = req.body;

  if (ideal_cycle_time === undefined || load_unload_allowance_seconds === undefined || !planned_start || !planned_end) {
    return res.status(400).json({ error: 'ideal_cycle_time, load_unload_allowance_seconds, planned_start, and planned_end are required' });
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
    if (part_number && part_number !== entry.part_number) {
      return res.status(400).json({ error: 'Changing the Part Number is not allowed - delete this entry and create a new one instead' });
    }
    if (part_name && part_name !== entry.part_name) {
      return res.status(400).json({ error: 'Changing the Part Name is not allowed - delete this entry and create a new one instead' });
    }

    const { idealCycleTime, allowanceSeconds, targetResult } = resolveAutoTarget(
      ideal_cycle_time, load_unload_allowance_seconds, entry.plan_date, planned_start, planned_end
    );
    const numTarget = targetResult.target;

    await db.query(
      'UPDATE part_schedules SET target = ?, ideal_cycle_time = ?, part_number = ?, part_name = ?, part_operation = ?, load_unload_allowance_seconds = ?, planned_start = ?, planned_end = ?, updated_by = ? WHERE id = ?',
      [numTarget, idealCycleTime, entry.part_number, entry.part_name, part_operation?.trim() || null, allowanceSeconds, planned_start, planned_end, req.user.loginId, id]
    );

    // If this entry is the one currently live, push the edited target/cycle onto the machine
    // immediately - it's the same part continuing, so nothing resets. Operator is left as-is.
    if (entry.status === 'Running') {
      await db.query(
        'UPDATE machines SET target = ?, ideal_cycle_time = ? WHERE id = ? AND active_schedule_id = ?',
        [numTarget, idealCycleTime, entry.machine_id, id]
      );
    }

    await recordAuditLog(req.user.loginId, 'PART_SCHEDULE_UPDATE', `${entry.machine_id}/${entry.plan_date}/${entry.shift}`, `#${entry.sequence} ${entry.part_name} (auto target=${numTarget})`);

    res.json({ success: true, message: 'Part schedule entry updated', target: numTarget });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
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
          (machine_id, plan_date, shift, sequence, part_name, part_number, part_operation, target, ideal_cycle_time, load_unload_allowance_seconds, operator, planned_start, planned_end, status, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?, ?)`,
        [
          source.machine_id, targetDate, source.shift, source.sequence, source.part_name, source.part_number || null, source.part_operation || null,
          source.target, source.ideal_cycle_time, source.load_unload_allowance_seconds || null,
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

/**
 * POST /api/part-schedules/assign-operator - Supervisor/Admin only. Assigns (or clears, with
 * operator: null) one operator across every part_schedules entry for a (machine, date, shift) -
 * the operator works the whole shift regardless of which scheduled part is currently running,
 * so this intentionally applies to the whole shift's entries at once rather than one at a time.
 * This is the ONLY write path for the `operator` column - see partSchedules.js's POST/PUT
 * routes above, which no longer accept it from the PPC Engineer at all.
 */
router.post('/assign-operator', requireAuth, requireRole('Supervisor', 'Admin'), async (req, res) => {
  const { machine_id, plan_date, shift, operator } = req.body;

  if (!machine_id || !plan_date || !shift) {
    return res.status(400).json({ error: 'machine_id, plan_date, and shift are required' });
  }
  if (!DATE_RE.test(plan_date)) {
    return res.status(400).json({ error: 'plan_date must be in YYYY-MM-DD format' });
  }
  if (!SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }

  const operatorId = operator ? String(operator).trim() : null;

  try {
    const [entries] = await db.query(
      'SELECT id FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [machine_id, plan_date, shift]
    );
    if (entries.length === 0) {
      return res.status(404).json({ error: 'No scheduled parts found for this machine/date/shift' });
    }

    // Double-booking guard: this operator must not already be on a DIFFERENT machine for the
    // same date/shift. Clearing an assignment (operatorId === null) skips this check entirely.
    if (operatorId) {
      const [conflicts] = await db.query(
        'SELECT DISTINCT machine_id FROM part_schedules WHERE plan_date = ? AND shift = ? AND operator = ? AND machine_id != ?',
        [plan_date, shift, operatorId, machine_id]
      );
      if (conflicts.length > 0) {
        return res.status(409).json({ error: `Operator "${operatorId}" is already assigned to machine ${conflicts[0].machine_id} for ${shift} on ${plan_date}` });
      }
    }

    await db.query(
      'UPDATE part_schedules SET operator = ?, updated_by = ? WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [operatorId, req.user.loginId, machine_id, plan_date, shift]
    );

    // If one of these entries is the machine's currently-active one, push the operator onto the
    // live machine row immediately too (same "push live" pattern the target/cycle edits use).
    const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machine_id]);
    if (machineRows.length > 0 && machineRows[0].active_schedule_id) {
      const isActiveEntryInThisShift = entries.some((e) => e.id === machineRows[0].active_schedule_id);
      if (isActiveEntryInThisShift) {
        await db.query('UPDATE machines SET assigned_operator = ? WHERE id = ?', [operatorId || 'Unassigned', machine_id]);
      }
    }

    await recordAuditLog(
      req.user.loginId,
      'OPERATOR_ASSIGN',
      `${machine_id}/${plan_date}/${shift}`,
      operatorId ? `Assigned ${operatorId}` : 'Cleared assignment'
    );

    res.json({ success: true, message: operatorId ? `Assigned ${operatorId} to ${machine_id} (${shift})` : 'Operator assignment cleared' });
  } catch (err) {
    logger.error('API Error: POST /part-schedules/assign-operator:', err.message);
    res.status(500).json({ error: 'Failed to assign operator' });
  }
});

export default router;
