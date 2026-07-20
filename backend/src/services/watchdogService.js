import db from '../config/db.js';
import { handleStatusMessage } from './mqttService.js';
import { sendSerialCommand } from './serialService.js';
import { resetProductionCounters } from './productionRecordService.js';
import { activateScheduleEntry } from './partScheduleService.js';
import { logger } from '../utils/logger.js';
import { getShiftForTimestamp, toDateOnlyString } from '../config/shifts.js';

// Per-machine last-seen shift, so an actual shift boundary crossing (vs. just a same-shift
// plan value edit) can be told apart and trigger a counter reset exactly once.
const lastSeenShift = new Map();

// Per-machine, once-per-shift-exhaustion log guard (avoids spamming the log every 10s once
// a machine has run through its whole scheduled part list).
const exhaustedLogged = new Set();

/**
 * Builds a local-time Date from a 'YYYY-MM-DD' date string and a 'HH:MM:SS' time string,
 * matching the local-constructor pattern config/shifts.js already uses to avoid UTC-parsing
 * ambiguity with bare ISO strings.
 */
function buildLocalDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  return new Date(year, month - 1, day, hh, mm, ss || 0);
}

/**
 * Auto-advances each machine's active scheduled part: closes out the current entry and
 * activates the next one in sequence when either its target quantity is reached or its
 * planned end time arrives (whichever comes first), and resets counters at shift boundaries.
 * All actual state transitions go through activateScheduleEntry() (the single choke-point
 * shared with the PPC Engineer's manual override endpoint).
 */
async function applyScheduledParts() {
  const today = toDateOnlyString();
  const currentShift = getShiftForTimestamp(new Date());
  const now = new Date();

  const [machines] = await db.query('SELECT * FROM machines');
  const [todaysEntries] = await db.query(
    'SELECT * FROM part_schedules WHERE plan_date = ? AND shift = ? ORDER BY sequence ASC',
    [today, currentShift]
  );

  for (const machine of machines) {
    // Only reset once we've actually observed a prior shift for this machine (skips a
    // spurious reset on process boot, when nothing has been "seen" yet).
    const previousShift = lastSeenShift.get(machine.id);
    if (previousShift && previousShift !== currentShift) {
      await resetProductionCounters(machine.id, 'shift_change');
      await db.query('UPDATE machines SET active_schedule_id = NULL WHERE id = ?', [machine.id]);
      machine.active_schedule_id = null;
      machine.production_count = 0;
      exhaustedLogged.delete(machine.id);
      logger.info(`⏰ Watchdog: Shift boundary crossed for machine ${machine.id} (${previousShift} -> ${currentShift}), production counters reset.`);
    }
    lastSeenShift.set(machine.id, currentShift);

    const machineEntries = todaysEntries.filter((e) => e.machine_id === machine.id);
    if (machineEntries.length === 0) continue; // no schedule for this machine/shift - legacy/manual mode

    const activeEntries = machineEntries.filter((e) => e.status !== 'Completed' && e.status !== 'Skipped');
    const currentEntry = machineEntries.find((e) => e.id === machine.active_schedule_id) || null;

    let nextEntry = null;
    let trigger = null;

    if (currentEntry) {
      const targetReached = machine.production_count >= currentEntry.target;
      const endTimeReached = now >= buildLocalDateTime(today, currentEntry.planned_end);

      if (targetReached || endTimeReached) {
        nextEntry = activeEntries.find((e) => e.sequence > currentEntry.sequence) || null;
        trigger = targetReached ? 'auto_target_reached' : 'auto_end_time';

        if (!nextEntry && !exhaustedLogged.has(machine.id)) {
          logger.info(`⏰ Watchdog: Machine ${machine.id} has finished its last scheduled part ("${currentEntry.part_name}") with no further entries queued - leaving it active.`);
          exhaustedLogged.add(machine.id);
        }
      }
    } else {
      // Nothing active yet this shift - activate the first pending entry whose window has opened.
      nextEntry = activeEntries.find((e) => e.status === 'Pending' && buildLocalDateTime(today, e.planned_start) <= now) || null;
      trigger = 'auto_start';
    }

    if (nextEntry) {
      exhaustedLogged.delete(machine.id);
      await activateScheduleEntry(machine.id, nextEntry, { changedBy: 'system', changeTrigger: trigger });
    }
  }
}

let watchdogInterval = null;

// Per-machine, per-alert-type cooldown so a persistent condition doesn't spam the
// notification feed every 10-second tick.
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const lastAlertedAt = new Map(); // `${machineId}:${alertType}` -> timestamp

function shouldEmitAlert(key) {
  const last = lastAlertedAt.get(key);
  const now = Date.now();
  if (last && now - last < ALERT_COOLDOWN_MS) return false;
  lastAlertedAt.set(key, now);
  return true;
}

/**
 * Starts the stale-pulse watchdog service
 * @param {Function} [broadcast] - Optional WS broadcast callback used to push ALERT notifications
 */
export function startWatchdogService(broadcast) {
  const checkInterval = 10000; // Check every 10 seconds
  logger.info('⏰ Watchdog Service: Starting background stale-pulse monitor...');

  const emitAlert = (alert) => {
    if (typeof broadcast === 'function') {
      broadcast({ type: 'ALERT', timestamp: new Date(), ...alert });
    }
  };

  watchdogInterval = setInterval(async () => {
    try {
      await applyScheduledParts();
    } catch (err) {
      logger.error('Watchdog Service Error (scheduled part sync):', err.message);
    }

    try {
      // Find all machines that are currently marked as Running, along with when the
      // current Running period actually started (the open status_logs row).
      const [machines] = await db.query(`
        SELECT m.*, sl.start_time AS running_since
        FROM machines m
        LEFT JOIN status_logs sl ON sl.machine_id = m.id AND sl.end_time IS NULL
        WHERE m.status = 'Running'
      `);
      const now = new Date();

      for (const machine of machines) {
        // Skip machines that have never sent a pulse and have no open Running log yet
        if (!machine.last_pulse && !machine.running_since) continue;

        // Use whichever is more recent: a stale last_pulse from before a stop/resume
        // must not count the downtime gap against the machine the moment it resumes.
        const lastPulseTime = machine.last_pulse ? new Date(machine.last_pulse).getTime() : 0;
        const runningSinceTime = machine.running_since ? new Date(machine.running_since).getTime() : 0;
        const baseTime = Math.max(lastPulseTime, runningSinceTime);
        const secondsSinceLastPulse = (now.getTime() - baseTime) / 1000;

        // Threshold is the ideal cycle time plus a 2 minute (120 second) grace period
        const threshold = machine.ideal_cycle_time + 120;

        if (secondsSinceLastPulse > threshold) {
          logger.info(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") is stale (No pulse for ${secondsSinceLastPulse.toFixed(1)}s, threshold: ${threshold}s). Setting status to Stopped.`);

          // Trigger physical machine lockout interlock relay
          try {
            await sendSerialCommand(machine.id, 'stop');
          } catch (serialErr) {
            logger.warn(`Watchdog: Failed to send interlock stop command: ${serialErr.message}`);
          }

          // Force-transition status to Stopped (closes running log and creates stopped log)
          await handleStatusMessage(machine.id, 'Stopped');

          if (shouldEmitAlert(`${machine.id}:stale`)) {
            emitAlert({
              severity: 'critical',
              machineId: machine.id,
              machineName: machine.name,
              message: `${machine.name} auto-stopped: no signal for ${Math.round(secondsSinceLastPulse)}s`
            });
          }
        }

        // High scrap-rate alert (informational, not tied to the stale-pulse lockout above)
        if (machine.production_count >= 20) {
          const scrapRate = machine.scrap_count / machine.production_count;
          if (scrapRate > 0.05 && shouldEmitAlert(`${machine.id}:scrap`)) {
            emitAlert({
              severity: 'warning',
              machineId: machine.id,
              machineName: machine.name,
              message: `${machine.name} scrap rate is ${(scrapRate * 100).toFixed(1)}% (${machine.scrap_count}/${machine.production_count})`
            });
          }
        }
      }
    } catch (err) {
      logger.error('Watchdog Service Error:', err.message);
    }
  }, checkInterval);
}

/**
 * Stops the stale-pulse watchdog service
 */
export function stopWatchdogService() {
  if (watchdogInterval) {
    clearInterval(watchdogInterval);
    watchdogInterval = null;
    logger.info('⏰ Watchdog Service: Stopped.');
  }
}
