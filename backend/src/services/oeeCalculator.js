import db from '../config/db.js';
import { PREDEFINED_REASONS } from '../config/reasonCodes.js';
import { getShiftForTimestamp, getCurrentShiftStart } from '../config/shifts.js';

export { PREDEFINED_REASONS };

/**
 * Returns planned break intervals for today
 */
export function getPlannedBreaks(midnight) {
  const breaks = [];
  
  // Shift C Break: Tea (03:00 - 03:20)
  breaks.push({
    start: new Date(midnight.getTime() + 3 * 3600000),
    end: new Date(midnight.getTime() + (3 * 3600000 + 20 * 60000))
  });
  
  // Shift A Breaks: Tea (10:00 - 10:20), Lunch (12:30 - 13:00)
  breaks.push({
    start: new Date(midnight.getTime() + 10 * 3600000),
    end: new Date(midnight.getTime() + (10 * 3600000 + 20 * 60000))
  });
  breaks.push({
    start: new Date(midnight.getTime() + 12.5 * 3600000),
    end: new Date(midnight.getTime() + 13 * 3600000)
  });
  
  // Shift B Breaks: Tea (18:30 - 18:50), Dinner (20:30 - 21:00)
  breaks.push({
    start: new Date(midnight.getTime() + 18.5 * 3600000),
    end: new Date(midnight.getTime() + (18.5 * 3600000 + 20 * 60000))
  });
  breaks.push({
    start: new Date(midnight.getTime() + 20.5 * 3600000),
    end: new Date(midnight.getTime() + 21 * 3600000)
  });
  
  return breaks;
}

/**
 * Calculates overlap in seconds between two date intervals
 */
export function getIntervalOverlapSeconds(start1, end1, start2, end2) {
  const s = Math.max(start1.getTime(), start2.getTime());
  const e = Math.min(end1.getTime(), end2.getTime());
  return Math.max(0, (e - s) / 1000);
}

/**
 * Clips a set of status_logs rows to [windowStart, windowEnd], subtracts any overlap with the
 * given planned breaks, and buckets the remaining duration into Running/Stopped/No Signal
 * totals (plus downtime-by-reason). Shared by the live "since midnight" calculation below and
 * reportingService.js's arbitrary historical windows, so the two can never compute utilization
 * differently.
 */
export function aggregateStatusLogs(logs, windowStart, windowEnd, breaks) {
  let runningSeconds = 0;
  let stoppedSeconds = 0;
  let noSignalSeconds = 0;
  let breakSeconds = 0;

  const downtimeReasons = {};
  PREDEFINED_REASONS.forEach(r => downtimeReasons[r] = 0);

  logs.forEach(log => {
    const logStart = new Date(Math.max(new Date(log.start_time).getTime(), windowStart.getTime()));
    const logEnd = log.end_time ? new Date(Math.min(new Date(log.end_time).getTime(), windowEnd.getTime())) : windowEnd;
    let durationSeconds = Math.max(0, (logEnd.getTime() - logStart.getTime()) / 1000);

    // Subtract any planned break overlap so operators are not penalized for lunch/tea breaks
    let overlapSeconds = 0;
    breaks.forEach(b => {
      overlapSeconds += getIntervalOverlapSeconds(logStart, logEnd, b.start, b.end);
    });
    durationSeconds -= overlapSeconds;
    breakSeconds += overlapSeconds;

    if (log.status === 'Running') {
      runningSeconds += durationSeconds;
    } else if (log.status === 'Stopped') {
      stoppedSeconds += durationSeconds;
      // Group by reason if available
      const reason = log.downtime_reason || 'Other';
      if (downtimeReasons[reason] !== undefined) {
        downtimeReasons[reason] += durationSeconds;
      } else {
        downtimeReasons['Other'] += durationSeconds;
      }
    } else if (log.status === 'No Signal') {
      noSignalSeconds += durationSeconds;
    }
  });

  return { runningSeconds, stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons };
}

/**
 * Availability/Performance/Quality/OEE - the one and only place these formulas are implemented.
 * Both the live "today" calculation below and reportingService.js's historical report call
 * this same pure function so the two can never drift apart.
 */
export function computeOeeFromTotals({ plannedSeconds, operatingSeconds, totalCount, goodCount, idealCycleTime }) {
  // Availability = Running Time / Planned Production Time. No KPI defaults to 100% when there's
  // no data yet - a machine that hasn't run this shift has 0% availability, not 100%.
  let availability = plannedSeconds > 0
    ? (operatingSeconds / plannedSeconds) * 100
    : 0;
  availability = Math.max(0, Math.min(100, availability));

  // Performance = (Ideal Cycle Time * Total Count) / Running Time
  let performance = 0;
  if (operatingSeconds > 0) {
    performance = ((totalCount * idealCycleTime) / operatingSeconds) * 100;
    performance = Math.max(0, Math.min(100, performance));
  }

  // Quality = Good Parts / Total Count
  let quality = 100;
  if (totalCount > 0) {
    quality = (goodCount / totalCount) * 100;
    quality = Math.max(0, Math.min(100, quality));
  }

  const oee = (availability / 100) * (performance / 100) * (quality / 100) * 100;

  return { availability, performance, quality, oee };
}

/**
 * Calculates Availability, Performance, Quality, OEE, shifts count,
 * machine utilization, downtime reasons, and last cycle time.
 */
export async function calculateOEE(machineId) {
  const now = new Date();
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  // Shift Elapsed Time resets at every shift change, unlike since-midnight accounting - a
  // machine that hasn't started this shift must show the full shift gap as downtime instead
  // of inheriting Running/Stopped time logged during a previous shift today.
  const shiftStart = getCurrentShiftStart(now);

  try {
    // 1. Fetch machine details
    const [machines] = await db.query('SELECT * FROM machines WHERE id = ?', [machineId]);
    if (machines.length === 0) {
      throw new Error(`Machine ${machineId} not found`);
    }
    const machine = machines[0];
    const idealCycleTime = machine.ideal_cycle_time;
    const totalCount = machine.production_count;
    const goodCount = machine.good_count;

    // 2. Fetch status logs since the current shift started (not midnight - Shift Elapsed Time
    // and Downtime must reset at each shift change, see shiftStart above)
    const [logs] = await db.query(
      'SELECT status, start_time, end_time, downtime_reason FROM status_logs WHERE machine_id = ? AND (end_time IS NULL OR end_time >= ?)',
      [machineId, shiftStart]
    );

    // 3. Fetch pulses / shift-wise counts (optimized using DB-level aggregates)
    let lastCycleTime = 0;
    let shiftA = 0;
    let shiftB = 0;
    let shiftC = 0;

    // A Stop (operator-pressed or watchdog auto-stop) stamps last_cycle_reset_at - pulses from
    // before that reset must not still be reported as the "last cycle time" after a Resume.
    const lastCycleResetAt = machine.last_cycle_reset_at ? new Date(machine.last_cycle_reset_at) : null;

    if (db.isMock) {
      const [pulses] = await db.query(
        'SELECT timestamp, cycle_time, is_good FROM pulses WHERE machine_id = ? AND timestamp >= ?',
        [machineId, midnight]
      );

      // Calculate last cycle time (ignoring any pulse that predates the last Stop)
      const pulsesSinceReset = lastCycleResetAt
        ? pulses.filter((p) => new Date(p.timestamp).getTime() > lastCycleResetAt.getTime())
        : pulses;
      if (pulsesSinceReset.length > 0) {
        lastCycleTime = parseFloat(pulsesSinceReset[pulsesSinceReset.length - 1].cycle_time || 0);
      }

      // Shift-wise production count (A, B, C)
      pulses.forEach(pulse => {
        const shift = getShiftForTimestamp(pulse.timestamp);
        if (shift === 'Shift A') shiftA++;
        else if (shift === 'Shift B') shiftB++;
        else shiftC++;
      });
    } else {
      // 1. Fetch last cycle time (limit 1), ignoring any pulse that predates the last Stop
      const [lastPulseRows] = await db.query(
        'SELECT cycle_time FROM pulses WHERE machine_id = ? AND (? IS NULL OR timestamp > ?) ORDER BY timestamp DESC LIMIT 1',
        [machineId, lastCycleResetAt, lastCycleResetAt]
      );
      if (lastPulseRows.length > 0) {
        lastCycleTime = parseFloat(lastPulseRows[0].cycle_time || 0);
      }

      // 2. Perform DB aggregation for shift counts
      const [shiftRows] = await db.query(
        `SELECT 
          COALESCE(SUM(CASE WHEN HOUR(timestamp)*60 + MINUTE(timestamp) >= 420 AND HOUR(timestamp)*60 + MINUTE(timestamp) < 930 THEN 1 ELSE 0 END), 0) as shiftA,
          COALESCE(SUM(CASE WHEN HOUR(timestamp)*60 + MINUTE(timestamp) >= 930 AND HOUR(timestamp)*60 + MINUTE(timestamp) < 1440 THEN 1 ELSE 0 END), 0) as shiftB,
          COALESCE(SUM(CASE WHEN HOUR(timestamp)*60 + MINUTE(timestamp) < 420 THEN 1 ELSE 0 END), 0) as shiftC
         FROM pulses 
         WHERE machine_id = ? AND timestamp >= ?`,
        [machineId, midnight]
      );
      if (shiftRows.length > 0) {
        shiftA = parseInt(shiftRows[0].shiftA || 0);
        shiftB = parseInt(shiftRows[0].shiftB || 0);
        shiftC = parseInt(shiftRows[0].shiftC || 0);
      }
    }

    // 6. Aggregate this shift's status logs into utilization/downtime totals via the shared
    // helper. Running Time is summed directly from RUNNING intervals - it is the ground truth;
    // everything else (Downtime, Availability, Utilization) is derived FROM it below, never the
    // other way around. That's what prevents an unlogged gap (machine never started) from
    // silently being counted as productive time.
    const todayBreaks = getPlannedBreaks(midnight);
    const { runningSeconds, stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons } =
      aggregateStatusLogs(logs, shiftStart, now, todayBreaks);

    // Shift Elapsed Time = now - shift start (raw, includes planned breaks)
    const shiftElapsedSeconds = Math.max(0, (now.getTime() - shiftStart.getTime()) / 1000);
    // Planned Production Time = Shift Elapsed - Planned Break Elapsed
    const plannedSeconds = Math.max(1, shiftElapsedSeconds - breakSeconds);

    const runningPct = Math.max(0, Math.min(100, (runningSeconds / plannedSeconds) * 100));
    const stoppedPct = Math.max(0, Math.min(100, (stoppedSeconds / plannedSeconds) * 100));
    const noSignalPct = Math.max(0, Math.min(100, (noSignalSeconds / plannedSeconds) * 100));

    // Downtime = Shift Elapsed - Running Time - Planned Break Elapsed (i.e. Planned Time - Running).
    // If the machine has never entered RUNNING, runningSeconds is 0 and the entire elapsed shift
    // becomes downtime, as it should.
    const totalDowntimeSeconds = Math.max(0, plannedSeconds - runningSeconds);

    // Machine Utilization = Running Time / Shift Elapsed Time (0 if the shift has no elapsed time
    // yet). Deliberately uses raw Shift Elapsed, not Planned Production Time - see Availability
    // below for the break-excluded ratio.
    const machineUtilization = shiftElapsedSeconds > 0
      ? Math.max(0, Math.min(100, (runningSeconds / shiftElapsedSeconds) * 100))
      : 0;

    const { availability, performance, quality, oee } = computeOeeFromTotals({
      plannedSeconds,
      operatingSeconds: runningSeconds,
      totalCount,
      goodCount,
      idealCycleTime
    });

    // Determine current active shift
    const currentShift = getShiftForTimestamp(now);

    return {
      availability: parseFloat(availability.toFixed(1)),
      performance: parseFloat(performance.toFixed(1)),
      quality: parseFloat(quality.toFixed(1)),
      oee: parseFloat(oee.toFixed(1)),
      downtimeSeconds: Math.round(totalDowntimeSeconds),
      shiftElapsedSeconds: Math.round(shiftElapsedSeconds),
      machineUtilization: parseFloat(machineUtilization.toFixed(1)),
      lastCycleTime,
      currentShift,
      shifts: {
        A: shiftA,
        B: shiftB,
        C: shiftC
      },
      utilization: {
        Running: parseFloat(runningPct.toFixed(1)),
        Stopped: parseFloat(stoppedPct.toFixed(1)),
        NoSignal: parseFloat(noSignalPct.toFixed(1))
      },
      downtimeReasons: Object.keys(downtimeReasons).reduce((acc, key) => {
        acc[key] = Math.round(downtimeReasons[key]);
        return acc;
      }, {})
    };
  } catch (error) {
    console.error(`Error calculating OEE for machine ${machineId}:`, error.message);
    // No KPI should read 100% for a machine we know nothing about (e.g. a DB error mid-shift) -
    // that would silently mask real downtime, which is exactly the bug this whole calculator
    // exists to avoid.
    return {
      availability: 0,
      performance: 0,
      quality: 100,
      oee: 0,
      downtimeSeconds: 0,
      shiftElapsedSeconds: 0,
      machineUtilization: 0,
      lastCycleTime: 0,
      currentShift: 'Shift A',
      shifts: { A: 0, B: 0, C: 0 },
      utilization: { Running: 0, Stopped: 0, NoSignal: 0 },
      downtimeReasons: {}
    };
  }
}
