import db from '../config/db.js';
import { handleStatusMessage } from './mqttService.js';
import { sendSerialCommand } from './serialService.js';
import { logger } from '../utils/logger.js';
import { applyPlanToMachine } from '../routes/shiftPlans.js';
import { getShiftForTimestamp, toDateOnlyString } from '../config/shifts.js';

/**
 * Applies today's scheduled shift plan (if any) to each machine whose live
 * target/cycle-time/part/operator has drifted from it. This is what makes a plan someone
 * scheduled yesterday for "tomorrow" actually take effect at shift-change with nobody online.
 */
async function applyScheduledPlans() {
  const today = toDateOnlyString();
  const currentShift = getShiftForTimestamp(new Date());

  const [machines] = await db.query('SELECT * FROM machines');
  const [todaysPlans] = await db.query(
    'SELECT * FROM shift_plans WHERE plan_date = ? AND shift = ?',
    [today, currentShift]
  );

  for (const machine of machines) {
    const plan = todaysPlans.find((p) => p.machine_id === machine.id);
    if (!plan) continue;

    const plannedPart = plan.part_name || 'Unassigned';
    const plannedOperator = plan.operator || 'Unassigned';
    const differs = plan.target !== machine.target
      || plan.ideal_cycle_time !== machine.ideal_cycle_time
      || plannedPart !== machine.active_part_name
      || plannedOperator !== machine.assigned_operator;

    if (differs) {
      await applyPlanToMachine({
        machine_id: machine.id,
        target: plan.target,
        ideal_cycle_time: plan.ideal_cycle_time,
        part_name: plan.part_name,
        operator: plan.operator
      });
      logger.info(`⏰ Watchdog: Auto-applied scheduled shift plan to machine ${machine.id} for ${currentShift}`);
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
      await applyScheduledPlans();
    } catch (err) {
      logger.error('Watchdog Service Error (scheduled plan sync):', err.message);
    }

    try {
      // Find all machines that are currently marked as Running
      const [machines] = await db.query('SELECT * FROM machines WHERE status = "Running"');
      const now = new Date();

      for (const machine of machines) {
        // Skip machines that have never sent a pulse
        if (!machine.last_pulse) continue;

        const lastPulseTime = new Date(machine.last_pulse);
        const secondsSinceLastPulse = (now.getTime() - lastPulseTime.getTime()) / 1000;

        // Threshold is 5x ideal cycle time, or a minimum of 2 minutes (120 seconds)
        const threshold = Math.max(machine.ideal_cycle_time * 5, 120);

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
