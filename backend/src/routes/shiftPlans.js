import express from 'express';
import db from '../config/db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { logger } from '../utils/logger.js';
import { handleStatusMessage } from '../services/mqttService.js';
import { resetProductionCounters } from '../services/productionRecordService.js';
import { SHIFT_NAMES, getShiftForTimestamp, getShiftWindow, toDateOnlyString } from '../config/shifts.js';

const router = express.Router();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCurrentDateShift(planDate, shift) {
  return planDate === toDateOnlyString() && shift === getShiftForTimestamp(new Date());
}

/**
 * Pushes a plan's values onto the live machines row and rebroadcasts, so the shop floor
 * (operator terminal, OEE calc) reflects it immediately. Used when a saved/edited plan's
 * date+shift is the one active right now.
 */
export async function applyPlanToMachine(plan) {
  const [machines] = await db.query('SELECT status, active_part_name FROM machines WHERE id = ?', [plan.machine_id]);
  const status = machines.length > 0 ? machines[0].status : 'Running';
  const newPartName = plan.part_name || 'Unassigned';

  // A part change mid-shift closes out the previous part's tally as its own permanent
  // record before the new part starts counting from 0. A same-part edit (target/operator
  // only) does not reset anything.
  if (machines.length > 0 && machines[0].active_part_name !== newPartName) {
    await resetProductionCounters(plan.machine_id, 'part_change');
  }

  await db.query(
    'UPDATE machines SET target = ?, ideal_cycle_time = ?, active_part_name = ?, assigned_operator = ? WHERE id = ?',
    [plan.target, plan.ideal_cycle_time, newPartName, plan.operator || 'Unassigned', plan.machine_id]
  );
  await handleStatusMessage(plan.machine_id, status);
}

/**
 * Actual production for a machine within a given shift's time window on a given date.
 * Skips the query entirely for a window that hasn't started yet (future shift).
 */
async function computeActual(machineId, planDate, shift) {
  const { start, end } = getShiftWindow(planDate, shift);
  if (start > new Date()) {
    return { count: 0, good: 0, scrap: 0 };
  }

  const [pulses] = await db.query(
    'SELECT timestamp, is_good FROM pulses WHERE machine_id = ? AND timestamp >= ?',
    [machineId, start]
  );
  const windowPulses = pulses.filter((p) => new Date(p.timestamp) < end);
  const good = windowPulses.filter((p) => p.is_good === 1 || p.is_good === true).length;
  return { count: windowPulses.length, good, scrap: windowPulses.length - good };
}

/**
 * GET /api/shift-plans?date=YYYY-MM-DD
 * Returns every machine x shift for the date: the scheduled plan (or null) plus actuals.
 */
router.get('/', requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'A valid date query param (YYYY-MM-DD) is required' });
  }

  try {
    const [machines] = await db.query('SELECT id, name FROM machines');
    const [plans] = await db.query('SELECT * FROM shift_plans WHERE plan_date = ?', [date]);

    const rows = [];
    for (const machine of machines) {
      for (const shift of SHIFT_NAMES) {
        const plan = plans.find((p) => p.machine_id === machine.id && p.shift === shift) || null;
        const actual = await computeActual(machine.id, date, shift);
        rows.push({
          machineId: machine.id,
          machineName: machine.name,
          shift,
          plan: plan ? {
            id: plan.id,
            target: plan.target,
            ideal_cycle_time: plan.ideal_cycle_time,
            part_name: plan.part_name,
            operator: plan.operator,
            created_by: plan.created_by,
            updated_by: plan.updated_by
          } : null,
          actual
        });
      }
    }

    res.json({ date, editable: date >= toDateOnlyString(), rows });
  } catch (err) {
    logger.error('API Error: GET /shift-plans:', err.message);
    res.status(500).json({ error: 'Failed to retrieve shift plans' });
  }
});

/**
 * POST /api/shift-plans - creates or updates the plan for (machine_id, plan_date, shift).
 * Rejects past dates. If the date+shift is the one active right now, applies it live.
 */
router.post('/', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const { machine_id, plan_date, shift, target, ideal_cycle_time, part_name, operator } = req.body;

  if (!machine_id || !plan_date || !shift || target === undefined || ideal_cycle_time === undefined) {
    return res.status(400).json({ error: 'machine_id, plan_date, shift, target, and ideal_cycle_time are required' });
  }
  if (!DATE_RE.test(plan_date)) {
    return res.status(400).json({ error: 'plan_date must be in YYYY-MM-DD format' });
  }
  if (!SHIFT_NAMES.includes(shift)) {
    return res.status(400).json({ error: `shift must be one of: ${SHIFT_NAMES.join(', ')}` });
  }
  if (plan_date < toDateOnlyString()) {
    return res.status(400).json({ error: 'Cannot create a plan for a past date' });
  }

  const numTarget = parseInt(target);
  const numCycle = parseInt(ideal_cycle_time);
  if (isNaN(numTarget) || isNaN(numCycle)) {
    return res.status(400).json({ error: 'target and ideal_cycle_time must be valid numbers' });
  }

  try {
    const [existing] = await db.query(
      'SELECT id FROM shift_plans WHERE machine_id = ? AND plan_date = ? AND shift = ?',
      [machine_id, plan_date, shift]
    );

    let planId;
    if (existing.length > 0) {
      planId = existing[0].id;
      await db.query(
        'UPDATE shift_plans SET target = ?, ideal_cycle_time = ?, part_name = ?, operator = ?, updated_by = ? WHERE id = ?',
        [numTarget, numCycle, part_name || null, operator || null, req.user.loginId, planId]
      );
    } else {
      const [result] = await db.query(
        'INSERT INTO shift_plans (machine_id, plan_date, shift, target, ideal_cycle_time, part_name, operator, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [machine_id, plan_date, shift, numTarget, numCycle, part_name || null, operator || null, req.user.loginId, req.user.loginId]
      );
      planId = result.insertId;
    }

    if (isCurrentDateShift(plan_date, shift)) {
      await applyPlanToMachine({ machine_id, target: numTarget, ideal_cycle_time: numCycle, part_name, operator });
    }

    await recordAuditLog(req.user.loginId, 'SHIFT_PLAN_SAVE', `${machine_id}/${plan_date}/${shift}`, `target=${numTarget}, cycle=${numCycle}s`);

    res.json({ success: true, message: `Shift plan saved for ${machine_id} on ${plan_date} (${shift})`, id: planId });
  } catch (err) {
    logger.error('API Error: POST /shift-plans:', err.message);
    res.status(500).json({ error: 'Failed to save shift plan' });
  }
});

/**
 * PUT /api/shift-plans/:id - edits an existing plan. 403s once its date has become past.
 */
router.put('/:id', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { target, ideal_cycle_time, part_name, operator } = req.body;

  if (target === undefined || ideal_cycle_time === undefined) {
    return res.status(400).json({ error: 'target and ideal_cycle_time are required' });
  }
  const numTarget = parseInt(target);
  const numCycle = parseInt(ideal_cycle_time);
  if (isNaN(numTarget) || isNaN(numCycle)) {
    return res.status(400).json({ error: 'target and ideal_cycle_time must be valid numbers' });
  }

  try {
    const [rows] = await db.query('SELECT * FROM shift_plans WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Shift plan not found' });
    }
    const existingPlan = rows[0];

    if (existingPlan.plan_date < toDateOnlyString()) {
      return res.status(403).json({ error: 'This plan is in the past and can no longer be edited' });
    }

    await db.query(
      'UPDATE shift_plans SET target = ?, ideal_cycle_time = ?, part_name = ?, operator = ?, updated_by = ? WHERE id = ?',
      [numTarget, numCycle, part_name || null, operator || null, req.user.loginId, id]
    );

    if (isCurrentDateShift(existingPlan.plan_date, existingPlan.shift)) {
      await applyPlanToMachine({ machine_id: existingPlan.machine_id, target: numTarget, ideal_cycle_time: numCycle, part_name, operator });
    }

    await recordAuditLog(req.user.loginId, 'SHIFT_PLAN_UPDATE', `${existingPlan.machine_id}/${existingPlan.plan_date}/${existingPlan.shift}`, `target=${numTarget}, cycle=${numCycle}s`);

    res.json({ success: true, message: 'Shift plan updated' });
  } catch (err) {
    logger.error(`API Error: PUT /shift-plans/${id}:`, err.message);
    res.status(500).json({ error: 'Failed to update shift plan' });
  }
});

/**
 * POST /api/shift-plans/copy-day - copies every machine/shift plan from sourceDate onto
 * targetDate (upsert). Used by the "Copy Previous Day" button.
 */
router.post('/copy-day', requireAuth, requireRole('PPC Engineer', 'Admin'), async (req, res) => {
  const { sourceDate, targetDate } = req.body;

  if (!sourceDate || !targetDate || !DATE_RE.test(sourceDate) || !DATE_RE.test(targetDate)) {
    return res.status(400).json({ error: 'sourceDate and targetDate (YYYY-MM-DD) are required' });
  }
  if (targetDate < toDateOnlyString()) {
    return res.status(400).json({ error: 'Cannot copy a plan onto a past date' });
  }

  try {
    const [sourcePlans] = await db.query('SELECT * FROM shift_plans WHERE plan_date = ?', [sourceDate]);
    if (sourcePlans.length === 0) {
      return res.status(404).json({ error: `No plans found on ${sourceDate} to copy` });
    }

    let copied = 0;
    for (const source of sourcePlans) {
      const [existing] = await db.query(
        'SELECT id FROM shift_plans WHERE machine_id = ? AND plan_date = ? AND shift = ?',
        [source.machine_id, targetDate, source.shift]
      );

      if (existing.length > 0) {
        await db.query(
          'UPDATE shift_plans SET target = ?, ideal_cycle_time = ?, part_name = ?, operator = ?, updated_by = ? WHERE id = ?',
          [source.target, source.ideal_cycle_time, source.part_name, source.operator, req.user.loginId, existing[0].id]
        );
      } else {
        await db.query(
          'INSERT INTO shift_plans (machine_id, plan_date, shift, target, ideal_cycle_time, part_name, operator, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [source.machine_id, targetDate, source.shift, source.target, source.ideal_cycle_time, source.part_name, source.operator, req.user.loginId, req.user.loginId]
        );
      }

      if (isCurrentDateShift(targetDate, source.shift)) {
        await applyPlanToMachine({ machine_id: source.machine_id, target: source.target, ideal_cycle_time: source.ideal_cycle_time, part_name: source.part_name, operator: source.operator });
      }
      copied++;
    }

    await recordAuditLog(req.user.loginId, 'SHIFT_PLAN_COPY', `${sourceDate} -> ${targetDate}`, `${copied} plan(s) copied`);

    res.json({ success: true, message: `Copied ${copied} plan(s) from ${sourceDate} to ${targetDate}` });
  } catch (err) {
    logger.error('API Error: POST /shift-plans/copy-day:', err.message);
    res.status(500).json({ error: 'Failed to copy shift plans' });
  }
});

export default router;
