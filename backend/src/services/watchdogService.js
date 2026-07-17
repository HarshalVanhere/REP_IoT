import db from '../config/db.js';
import { handleStatusMessage } from './mqttService.js';

let watchdogInterval = null;

/**
 * Starts the stale-pulse watchdog service
 */
export function startWatchdogService() {
  const checkInterval = 10000; // Check every 10 seconds
  console.log('⏰ Watchdog Service: Starting background stale-pulse monitor...');

  watchdogInterval = setInterval(async () => {
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
          console.log(`⏰ Watchdog: Machine ${machine.id} ("${machine.name}") is stale (No pulse for ${secondsSinceLastPulse.toFixed(1)}s, threshold: ${threshold}s). Setting status to Stopped.`);
          
          // Force-transition status to Stopped (closes running log and creates stopped log)
          await handleStatusMessage(machine.id, 'Stopped');
        }
      }
    } catch (err) {
      console.error('❌ Watchdog Service Error:', err.message);
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
    console.log('⏰ Watchdog Service: Stopped.');
  }
}
