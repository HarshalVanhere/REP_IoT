import db from '../config/db.js';
import { logger } from '../utils/logger.js';
import { handleStatusMessage } from './mqttService.js';
import { getShiftForTimestamp } from '../config/shifts.js';

/**
 * Snapshots a machine's current live production counters into the permanent
 * production_records table, then resets those counters to 0 so the next part/shift starts
 * clean. production_records is append-only - this never touches the pulses/status_logs
 * history that real OEE/report calculations are based on, it only closes out the live
 * "current run" tally shown on the operator terminal.
 *
 * production_records doubles as the part-change audit trail (requirement: previous part, new
 * part, who changed it, why) - `auditFields` carries the extra context a schedule-driven
 * reset needs; plain shift_change/manual_reset callers can omit it entirely.
 *
 * @param {string} machineId
 * @param {'shift_change'|'part_change'|'manual_reset'} reason
 * @param {string|null} resetBy - loginId of who triggered this (or 'system' for automatic), else null
 * @param {{scheduleId?: number|null, nextPartName?: string|null, changeTrigger?: string|null, changeReason?: string|null}} auditFields
 */
export async function resetProductionCounters(machineId, reason, resetBy = null, auditFields = {}) {
  const { scheduleId = null, nextPartName = null, changeTrigger = null, changeReason = null } = auditFields;

  const [rows] = await db.query(
    'SELECT status, target, production_count, good_count, scrap_count, active_part_name, assigned_operator, segment_start FROM machines WHERE id = ?',
    [machineId]
  );
  if (rows.length === 0) return;
  const machine = rows[0];

  // Nothing produced yet this segment - no record worth keeping, just move the segment marker.
  if (machine.production_count === 0) {
    await db.query('UPDATE machines SET segment_start = NOW() WHERE id = ?', [machineId]);
    return;
  }

  await db.query(
    `INSERT INTO production_records
      (machine_id, part_name, operator, shift, target, production_count, good_count, scrap_count, reset_reason, reset_by, start_time,
       schedule_id, previous_part_name, next_part_name, changed_by, change_trigger, change_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      machineId,
      machine.active_part_name,
      machine.assigned_operator,
      getShiftForTimestamp(new Date()),
      machine.target,
      machine.production_count,
      machine.good_count,
      machine.scrap_count,
      reason,
      resetBy,
      machine.segment_start,
      scheduleId,
      machine.active_part_name,
      nextPartName,
      resetBy,
      changeTrigger,
      changeReason
    ]
  );

  await db.query(
    'UPDATE machines SET production_count = 0, good_count = 0, scrap_count = 0, segment_start = NOW() WHERE id = ?',
    [machineId]
  );

  logger.info(`📦 Production record closed for machine ${machineId} (${reason}): ${machine.production_count} pcs of "${machine.active_part_name}"`);

  // Recompute OEE and broadcast so connected screens reflect the reset counters immediately.
  await handleStatusMessage(machineId, machine.status);
}
