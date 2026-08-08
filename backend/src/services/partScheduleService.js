import db from '../config/db.js';
import { logger } from '../utils/logger.js';
import { resetProductionCounters } from './productionRecordService.js';
import { handleStatusMessage } from './mqttService.js';
import { recordAuditLog } from '../utils/auditLog.js';
import { withMachineLock } from '../utils/machineLock.js';

/**
 * The single choke-point for closing out whichever part is currently active on a machine and
 * activating `nextEntry` in its place. Called identically by the watchdog's auto-advance tick
 * and the PPC Engineer's manual override endpoint, so there is exactly one code path that can
 * ever mutate `machines.active_schedule_id` / `part_schedules.status`.
 *
 * @param {string} machineId
 * @param {object} nextEntry - a row from part_schedules (id, part_name, target, ideal_cycle_time, operator)
 * @param {{changedBy?: string|null, changeTrigger: string, changeReason?: string|null}} options
 */
export function activateScheduleEntry(machineId, nextEntry, { changedBy = null, changeTrigger, changeReason = null }) {
  return withMachineLock(machineId, async () => {
    const [machineRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machineId]);
    if (machineRows.length === 0) return;
    const currentScheduleId = machineRows[0].active_schedule_id;

    // Already active - a concurrent call (or a stale watchdog decision) got here first.
    if (currentScheduleId === nextEntry.id) return;

    let currentEntry = null;
    if (currentScheduleId) {
      const [currentRows] = await db.query('SELECT * FROM part_schedules WHERE id = ?', [currentScheduleId]);
      currentEntry = currentRows[0] || null;
    }

    await resetProductionCounters(machineId, 'part_change', changedBy, {
      scheduleId: currentEntry ? currentEntry.id : null,
      nextPartName: nextEntry.part_name,
      changeTrigger,
      changeReason
    });

    // part_schedules.status and machines.active_schedule_id must never be allowed to disagree -
    // as three separate statements, a failure between the part_schedules write and the machines
    // write (dropped connection, deadlock, process restart) previously left a part_schedules row
    // stuck at status='Running' while machines.active_schedule_id stayed pointing at nothing (or
    // NULL) - silently bricking that machine's auto-schedule pickup, since nothing else ever
    // retries a row that isn't 'Pending'. All-or-nothing makes that impossible.
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      if (currentEntry) {
        await connection.query("UPDATE part_schedules SET status = 'Completed', completed_at = NOW() WHERE id = ?", [currentEntry.id]);
      }
      await connection.query("UPDATE part_schedules SET status = 'Running', activated_at = NOW() WHERE id = ?", [nextEntry.id]);
      await connection.query(
        'UPDATE machines SET target = ?, ideal_cycle_time = ?, active_part_name = ?, assigned_operator = ?, active_schedule_id = ? WHERE id = ?',
        [nextEntry.target, nextEntry.ideal_cycle_time, nextEntry.part_name, nextEntry.operator || 'Unassigned', nextEntry.id, machineId]
      );
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const [statusRows] = await db.query('SELECT status FROM machines WHERE id = ?', [machineId]);
    if (statusRows.length > 0) {
      // Ensures a broadcast fires even when resetProductionCounters skipped it (no production
      // yet this segment, e.g. an override moments after the previous part activated).
      await handleStatusMessage(machineId, statusRows[0].status);
    }

    logger.info(`📋 Machine ${machineId}: part changed ${currentEntry ? `"${currentEntry.part_name}"` : '(none)'} -> "${nextEntry.part_name}" (${changeTrigger})`);

    await recordAuditLog(
      changedBy || 'system',
      changeTrigger === 'manual_override' ? 'PART_SCHEDULE_OVERRIDE' : 'PART_SCHEDULE_AUTO_ADVANCE',
      machineId,
      changeReason || `${currentEntry ? currentEntry.part_name : 'none'} -> ${nextEntry.part_name}`
    );
  });
}
