import db from '../config/db.js';
import { handleStatusMessage, ensureActiveStatusLog } from './mqttService.js';
import { sendSerialCommand } from './serialService.js';
import { resetProductionCounters } from './productionRecordService.js';
import { activateScheduleEntry } from './partScheduleService.js';
import { withMachineLock } from '../utils/machineLock.js';
import { logger } from '../utils/logger.js';
import { getShiftForTimestamp, toDateOnlyString, buildPlantDateTime } from '../config/shifts.js';

// Per-machine last-seen shift, so an actual shift boundary crossing (vs. just a same-shift
// plan value edit) can be told apart and trigger a counter reset exactly once.
const lastSeenShift = new Map();

// Per-machine, once-per-shift-exhaustion log guard (avoids spamming the log every 10s once
// a machine has run through its whole scheduled part list).
const exhaustedLogged = new Set();

// Per-machine, once-per-block log guard (avoids spamming the log every 10s while a machine
// sits blocked with no schedule for the current shift).
const noScheduleLogged = new Set();

/**
 * Enforces "no production without a valid schedule": clears whatever part/operator was
 * carried over (never lets a machine silently keep running - or resume - the previous shift's
 * or previous schedule's part) and force-stops the machine if it's currently Running. A
 * machine in this state stays blocked until the PPC Engineer creates and activates a real
 * schedule entry for the current machine/shift - nothing here can revive it automatically.
 */
function blockMachineWithoutSchedule(machine) {
  return withMachineLock(machine.id, async () => {
    // The entry being orphaned here was left with status = 'Running' by whatever last
    // activated it. If it's left that way, it can never be picked up again - the watchdog's
    // own auto-start (below) and the PPC manual-activate path both only ever select entries
    // with status = 'Pending'. Revert it so a later schedule fix/re-add can actually resume it.
    if (machine.active_schedule_id !== null) {
      await db.query(
        "UPDATE part_schedules SET status = 'Pending' WHERE id = ? AND status = 'Running'",
        [machine.active_schedule_id]
      );
    }
    await db.query(
      'UPDATE machines SET active_part_name = NULL, assigned_operator = NULL, active_schedule_id = NULL WHERE id = ?',
      [machine.id]
    );

    if (machine.status === 'Running') {
      try {
        await sendSerialCommand(machine.id, 'stop');
      } catch (serialErr) {
        logger.warn(`Watchdog: Failed to send interlock stop command while blocking machine ${machine.id}: ${serialErr.message}`);
      }
      await handleStatusMessage(machine.id, 'Stopped');
    }

    if (!noScheduleLogged.has(machine.id)) {
      logger.info(`⏰ Watchdog: Machine ${machine.id} has no scheduled part for the current shift - blocking production until PPC creates a schedule.`);
      noScheduleLogged.add(machine.id);
    }
  });
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
    // lastSeenShift is in-memory and empty on every (re)start. On the very first tick for a
    // machine, fall back to the shift implied by segment_start (when its live tally last
    // began) instead of silently adopting currentShift - this catches a boundary that was
    // crossed while the process was down/restarting (crash, redeploy, Pi reboot) instead of
    // missing that reset entirely until the shift after next.
    const previousShift = lastSeenShift.get(machine.id)
      ?? (machine.segment_start ? getShiftForTimestamp(machine.segment_start) : currentShift);
    if (previousShift !== currentShift) {
      // CRITICAL FIX: this whole reset used to run outside withMachineLock, mutating
      // `machines`/`part_schedules` straight off the stale batch `SELECT * FROM machines` taken
      // at the top of this function. A PPC Engineer's manual activation for the NEW shift
      // (activateScheduleEntry, which DOES take the lock) landing in the gap between that batch
      // SELECT and this tick reaching the machine would get silently overwritten back to "no
      // schedule" by the unconditional UPDATEs below - the lock only protected one side of the
      // race. Wrapping this in the same lock, and re-reading fresh state inside it, makes this
      // race impossible: whichever of the two actually runs first now serializes against the other.
      await withMachineLock(machine.id, async () => {
        const [freshRows] = await db.query('SELECT active_schedule_id FROM machines WHERE id = ?', [machine.id]);
        if (freshRows.length === 0) return;
        const activeScheduleId = freshRows[0].active_schedule_id;

        if (activeScheduleId !== null) {
          const [entryRows] = await db.query('SELECT shift FROM part_schedules WHERE id = ?', [activeScheduleId]);
          // The currently-active entry already belongs to the shift we're transitioning INTO -
          // a concurrent manual override already handled this boundary for us. Leave it alone
          // instead of clobbering real work that landed between our batch SELECT and this lock.
          if (entryRows.length > 0 && entryRows[0].shift === currentShift) {
            return;
          }
        }

        await resetProductionCounters(machine.id, 'shift_change');
        // The outgoing entry (if any) was left with status = 'Running' by whatever activated
        // it. Revert it to 'Pending' here - otherwise, once orphaned from active_schedule_id,
        // it can never be auto-activated again (auto-start below, and the PPC manual-activate
        // path, both only select 'Pending' entries), permanently stranding it as "no schedule"
        // even after the PPC re-adds/edits it.
        if (activeScheduleId !== null) {
          await db.query(
            "UPDATE part_schedules SET status = 'Pending' WHERE id = ? AND status = 'Running'",
            [activeScheduleId]
          );
        }
        // Never carry the previous shift's part/operator into a new shift - a new shift starts
        // with nothing active until a schedule (for THIS shift) says otherwise. If one exists
        // below, it gets activated moments later in this same tick; if not, the machine stays
        // blocked exactly as blockMachineWithoutSchedule would leave it anyway.
        await db.query('UPDATE machines SET active_schedule_id = NULL, active_part_name = NULL, assigned_operator = NULL WHERE id = ?', [machine.id]);
      });

      // Refresh the in-memory snapshot used by the rest of THIS tick's logic below - the
      // lock-protected block above may have reset the machine, or found a concurrent override
      // already handled it, and either way `machine` here must reflect the real current state
      // before the auto-start logic further down decides what (if anything) to activate next.
      const [refreshedRows] = await db.query('SELECT * FROM machines WHERE id = ?', [machine.id]);
      if (refreshedRows.length > 0) {
        Object.assign(machine, refreshedRows[0]);
      }

      exhaustedLogged.delete(machine.id);
      noScheduleLogged.delete(machine.id);
      logger.info(`⏰ Watchdog: Shift boundary crossed for machine ${machine.id} (${previousShift} -> ${currentShift}).`);
    }
    lastSeenShift.set(machine.id, currentShift);

    const machineEntries = todaysEntries.filter((e) => e.machine_id === machine.id);
    if (machineEntries.length === 0) {
      // No schedule at all for this machine's current shift - production must not run.
      if (machine.active_schedule_id !== null || machine.active_part_name !== null) {
        await blockMachineWithoutSchedule(machine);
      }
      continue;
    }
    noScheduleLogged.delete(machine.id);

    const activeEntries = machineEntries.filter((e) => e.status !== 'Completed' && e.status !== 'Skipped');
    const currentEntry = machineEntries.find((e) => e.id === machine.active_schedule_id) || null;

    let nextEntry = null;
    let trigger = null;

    if (currentEntry) {
      const targetReached = machine.production_count >= currentEntry.target;
      const entryStartTime = buildPlantDateTime(today, currentEntry.planned_start);
      let entryEndTime = buildPlantDateTime(today, currentEntry.planned_end);
      // CRITICAL FIX: a window ending at midnight (e.g. Shift B's planned_end stored as
      // "00:00:00") means midnight of the FOLLOWING day, not the start of `today` itself - the
      // exact same rollover calculateAutoTarget() in oeeCalculator.js already accounts for.
      // Without this, buildPlantDateTime(today, "00:00:00") resolves to a moment hours in the
      // past the instant a Shift B entry activates, so endTimeReached was true on the very next
      // 10-second tick - cutting the part short seconds after it started and zeroing its counters.
      if (entryEndTime.getTime() <= entryStartTime.getTime()) {
        entryEndTime = new Date(entryEndTime.getTime() + 24 * 3600000);
      }
      const endTimeReached = now >= entryEndTime;

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
      nextEntry = activeEntries.find((e) => e.status === 'Pending' && buildPlantDateTime(today, e.planned_start) <= now) || null;
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
    // The part_schedules table (and therefore this auto-advance/no-schedule-block scheduler)
    // is only ever authoritative on the node PPC Engineers actually create schedules on. In a
    // split Edge Gateway + Cloud deployment, that's the Cloud backend - the Edge Gateway has
    // its own separate local DB whose part_schedules table is never written to (schedules never
    // sync downward, only the *resolved* target/cycle/part/operator/active_schedule_id do, via
    // syncService's pullMachineConfig). Running this scheduler on the Edge Gateway too meant it
    // saw an always-empty local table on every tick and concluded "no schedule" for every
    // machine, force-stopping it and wiping active_part_name/operator/active_schedule_id -
    // seconds after pullMachineConfig had just restored them from the Cloud. That fight (this
    // scheduler's 10s tick vs. pullMachineConfig's 5s tick) was the actual cause of: the "No
    // Part Scheduled" flicker, the machine dropping back to Stopped 2-3s after Resume, and the
    // Last Cycle value never settling (it kept getting reset by these spurious auto-stops and
    // then re-populated by the next pulse, unrelated to any real stop condition).
    // See syncService.pullMachineConfig() for the Edge Gateway's own schedule-presence check,
    // which is the correct single source of truth for "is there really no schedule" there.
    if (process.env.IS_EDGE_GATEWAY !== 'true') {
      try {
        await applyScheduledParts();
      } catch (err) {
        logger.error('Watchdog Service Error (scheduled part sync):', err.message);
      }
    }

    try {
      // A machine with iot_enabled = FALSE has no ESP32/Raspberry Pi wired up at all - it will
      // never produce a real pulse or status message, so nothing else in this codebase will ever
      // move it off whatever status it's stuck at. Force it to "Not Connected" on every tick
      // (both tiers, since this needs no physical serial access - just reflecting a registration
      // fact) so it can never be left showing a stale Running/Stopped state from before an Admin
      // disabled it, or the DB default before this feature existed.
      const [unconnectedMachines] = await db.query(
        "SELECT id, status FROM machines WHERE iot_enabled = FALSE AND status != 'Not Connected'"
      );
      for (const machine of unconnectedMachines) {
        await withMachineLock(machine.id, async () => {
          await handleStatusMessage(machine.id, 'Not Connected');
        });
      }
    } catch (err) {
      logger.error('Watchdog Service Error (connectivity enforcement):', err.message);
    }

    try {
      // Find all machines that are currently marked as Running, along with when the
      // current Running period actually started (the open status_logs row).
      const [machines] = await db.query(`
        SELECT m.*, sl.start_time AS running_since
        FROM machines m
        LEFT JOIN status_logs sl ON sl.machine_id = m.id AND sl.end_time IS NULL AND sl.status = 'Running'
        WHERE m.status = 'Running'
      `);
      const now = new Date();

      for (const machine of machines) {
        // Skip machines that have never sent a pulse and have no open Running log yet
        if (!machine.last_pulse && !machine.running_since) continue;

        // Machine is Running but has no open status log - a resume racing with the ESP32's
        // own immediate status telemetry (both close/open status_logs independently, with no
        // locking between them) can leave zero open rows even though status is Running. Do
        // NOT let that fall back to a pre-stop last_pulse from hours ago - it would look
        // instantly "stale" and auto-stop the machine seconds after every long-stop resume.
        // Self-heal the missing log and give this tick a pass instead.
        if (!machine.running_since) {
          logger.warn(`⏰ Watchdog: Machine ${machine.id} is Running with no open status log (resume race) - self-healing, skipping this tick's stale check.`);
          await ensureActiveStatusLog(machine.id, 'Running', now);
          continue;
        }

        // Threshold is the machine's own configured heartbeat timeout (Admin-editable per
        // machine). The same column now backs a heartbeat-based check instead of a pulse-based
        // one (see below) - its existing values (default 120s) remain a sensible connectivity
        // timeout either way, so no migration/re-tuning is needed.
        const threshold = machine.heartbeat_timeout_seconds || 30;

        if (process.env.IS_EDGE_GATEWAY === 'true') {
          // Connectivity ("Not Connected") is judged ONLY on the heartbeat signal - never on
          // last_pulse / production-cycle timing. A machine with no heartbeat yet (legacy
          // firmware not reflashed) has no real connectivity signal to check, so it is simply
          // skipped here rather than substituting last_pulse, which would misread a normal idle
          // production pause as a communication failure.
          const usingHeartbeat = Boolean(machine.last_heartbeat);

          if (usingHeartbeat) {
            const secondsSinceSignal = (now.getTime() - new Date(machine.last_heartbeat).getTime()) / 1000;

            if (secondsSinceSignal > threshold) {
              logger.info(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") is stale (No heartbeat for ${secondsSinceSignal.toFixed(1)}s, threshold: ${threshold}s). Setting status to Not Connected.`);

              // Serialized against /stop, /resume, and pullMachineConfig's own force-stop path so
              // this can never fire in the middle of - or immediately undo - an operator action or
              // a schedule sync that's already in flight for the same machine.
              await withMachineLock(machine.id, async () => {
                // Trigger physical machine lockout interlock relay
                try {
                  await sendSerialCommand(machine.id, 'stop');
                } catch (serialErr) {
                  logger.warn(`Watchdog: Failed to send interlock stop command: ${serialErr.message}`);
                }

                // Force-transition status to Not Connected (closes running log and creates a Not
                // Connected log, and - see handleStatusMessage - stamps last_cycle_reset_at so Last
                // Cycle reads 0). Not "Stopped" - a machine that stopped communicating was not
                // necessarily manually stopped, and conflating the two hid genuine connectivity
                // loss behind a normal-looking Stopped state.
                await handleStatusMessage(machine.id, 'Not Connected');
              });

              if (shouldEmitAlert(`${machine.id}:stale`)) {
                emitAlert({
                  severity: 'critical',
                  machineId: machine.id,
                  machineName: machine.name,
                  message: `${machine.name} marked Not Connected: no heartbeat for ${Math.round(secondsSinceSignal)}s`
                });
              }
            }
          }

          // Production-cycle timeout: separate from, and never a cause of, "Not Connected" above.
          // A Running machine that hasn't produced a valid Cycle Complete pulse within
          // ideal_cycle_time + 120s is stuck/idle mid-cycle, not disconnected - connectivity is
          // judged solely by the heartbeat check above. This only ever results in "Stopped",
          // exactly as if an operator had pressed Stop, and never touches last_heartbeat.
          if (machine.status === 'Running') {
            const idealTime = machine.ideal_cycle_time || 15;
            const timeoutSeconds = idealTime + 120;

            // Most recent of last_pulse / running_since - last_pulse can be a stale leftover from
            // BEFORE the current Start/Resume, so anchoring on running_since when it's more recent
            // gives every fresh Start/Resume a full idealTime+120s grace window instead of being
            // judged stale on its very first tick.
            const lastPulseTime = machine.last_pulse ? new Date(machine.last_pulse).getTime() : 0;
            const runningSinceTime = machine.running_since ? new Date(machine.running_since).getTime() : 0;
            const lastValidPulseTime = Math.max(lastPulseTime, runningSinceTime);

            if (lastValidPulseTime === 0) {
              // Neither timestamp available - refuse to compute a timeout off Unix epoch 0, which
              // would always appear massively overdue and auto-stop the machine incorrectly.
              logger.warn(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") is Running but has neither last_pulse nor running_since - skipping cycle-timeout check this tick.`);
            } else {
              const secondsSinceLastPulse = (now.getTime() - lastValidPulseTime) / 1000;
              logger.info(`⏰ Watchdog: Machine ${machine.id} cycle-timeout check - status=${machine.status}, idealTime=${idealTime}s, last_pulse=${machine.last_pulse || 'null'}, running_since=${machine.running_since || 'null'}, lastValidPulseTime=${new Date(lastValidPulseTime).toISOString()}, secondsSinceLastPulse=${secondsSinceLastPulse.toFixed(1)}s, timeout=${timeoutSeconds}s.`);

              if (secondsSinceLastPulse > timeoutSeconds) {
                let stoppedNow = false;

                // Same lock as the connectivity path above. Re-reads current DB status inside the
                // lock because the batch SELECT at the top of this tick can be stale by the time
                // we get here - an operator's manual /stop or /resume, or the heartbeat check just
                // above, may have already changed it. Only proceed if it is STILL exactly
                // 'Running'; otherwise abort without sending another stop command or touching status.
                await withMachineLock(machine.id, async () => {
                  const [freshRows] = await db.query('SELECT status FROM machines WHERE id = ?', [machine.id]);
                  const freshStatus = freshRows.length > 0 ? freshRows[0].status : null;

                  if (freshStatus !== 'Running') {
                    logger.info(`⏰ Watchdog: Machine ${machine.id} cycle-timeout fired but current DB status is "${freshStatus}" (not Running) - aborting auto-stop.`);
                    return;
                  }

                  logger.info(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") exceeded cycle timeout (idealTime ${idealTime}s + 120s = ${timeoutSeconds}s, elapsed ${secondsSinceLastPulse.toFixed(1)}s). Auto-stopping (status -> Stopped; connectivity unaffected).`);

                  try {
                    await sendSerialCommand(machine.id, 'stop');
                  } catch (serialErr) {
                    logger.warn(`Watchdog: Failed to send interlock stop command (cycle timeout): ${serialErr.message}`);
                  }

                  // "Stopped", never "Not Connected" - the machine is still communicating
                  // (heartbeat is judged independently above), it simply did not complete a cycle
                  // in time. Nothing here touches last_heartbeat, so connectivity is untouched.
                  await handleStatusMessage(machine.id, 'Stopped');
                  stoppedNow = true;
                });

                if (stoppedNow && shouldEmitAlert(`${machine.id}:cycle-timeout`)) {
                  emitAlert({
                    severity: 'warning',
                    machineId: machine.id,
                    machineName: machine.name,
                    message: `${machine.name} auto-stopped: no cycle-complete pulse for ${Math.round(secondsSinceLastPulse)}s (ideal cycle ${idealTime}s + 120s grace)`
                  });
                }
              }
            }
          }
        } else {
          // Cloud sync-lag warning - deliberately still pulse-based, unchanged. This measures a
          // genuinely different thing than ESP32<->Pi connectivity above: whether the Edge
          // Gateway's own HTTP upload pipeline (syncService.js, every 5s) is keeping up, which is
          // exactly what a stale last_pulse on the Cloud actually reflects. Heartbeats are a
          // purely local, real-time liveness signal between the ESP32 and its Pi - they are never
          // uploaded to the Cloud (uploading a value every 5s just to detect a sync lag that
          // last_pulse already detects would be redundant), so the Cloud has no heartbeat signal
          // to check here even in principle. Cloud never forces machines.status off this signal
          // either way - the Edge Gateway remains the sole authority allowed to actually stop a
          // machine (see the comment on the branch above).
          const lastPulseTime = machine.last_pulse ? new Date(machine.last_pulse).getTime() : 0;
          const runningSinceTime = machine.running_since ? new Date(machine.running_since).getTime() : 0;
          const baseTime = Math.max(lastPulseTime, runningSinceTime);
          const secondsSinceLastPulse = (now.getTime() - baseTime) / 1000;

          if (secondsSinceLastPulse > threshold) {
            logger.warn(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") has not synced from its Edge Gateway in ${secondsSinceLastPulse.toFixed(1)}s (threshold: ${threshold}s) - leaving status as-is, Cloud is not authoritative for stopping machines.`);

            if (shouldEmitAlert(`${machine.id}:sync-lag`)) {
              emitAlert({
                severity: 'warning',
                machineId: machine.id,
                machineName: machine.name,
                message: `${machine.name}: no data synced from its Edge Gateway for ${Math.round(secondsSinceLastPulse)}s - dashboard may be stale`
              });
            }
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
