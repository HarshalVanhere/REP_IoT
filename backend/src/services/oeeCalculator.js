import db from '../config/db.js';
import { PREDEFINED_REASONS } from '../config/reasonCodes.js';
import { getShiftForTimestamp, getCurrentShiftStart, getShiftWindow, buildPlantDateTime } from '../config/shifts.js';

export { PREDEFINED_REASONS };

/**
 * Planned-break treatment rules - the single reference for which calculations exclude planned
 * breaks (Tea/Lunch/Dinner, see getPlannedBreaks below) from their time base, and which don't:
 *
 *   - Production Target (calculateAutoTarget): EXCLUDES breaks - available production time is
 *     the scheduled window minus any break falling inside it.
 *   - Availability (computeOeeFromTotals): EXCLUDES breaks - denominator is Planned Production
 *     Time, itself window duration minus break seconds.
 *   - Performance, Quality: unaffected either way - both are ratios of counts/Operating Time,
 *     never of window duration.
 *   - OEE: inherits Availability's break-exclusion transitively (OEE = A x P x Q).
 *   - Machine Utilization: the one deliberate exception - INCLUDES breaks (Running Time / raw
 *     window duration). This is a broader "how much of the clock was this machine adding value"
 *     KPI, intentionally distinct from TPM Availability.
 */

/**
 * Returns planned break intervals for today
 */
export function getPlannedBreaks(midnight) {
  const breaks = [];

  // start/end given as minutes-from-midnight, converted to ms offsets from `midnight`.
  const addBreak = (startMinutes, endMinutes) => {
    breaks.push({
      start: new Date(midnight.getTime() + startMinutes * 60000),
      end: new Date(midnight.getTime() + endMinutes * 60000)
    });
  };

  // Shift C Breaks: Tea (02:00 - 02:10), Tea (05:00 - 05:10)
  addBreak(2 * 60, 2 * 60 + 10);
  addBreak(5 * 60, 5 * 60 + 10);

  // Shift A Breaks: Tea (09:00 - 09:10), Lunch (11:30 - 12:00), Tea (14:00 - 14:10)
  addBreak(9 * 60, 9 * 60 + 10);
  addBreak(11 * 60 + 30, 12 * 60);
  addBreak(14 * 60, 14 * 60 + 10);

  // Shift B Breaks: Tea (17:30 - 17:40), Dinner (20:00 - 20:30), Tea (21:30 - 21:40)
  addBreak(17 * 60 + 30, 17 * 60 + 40);
  addBreak(20 * 60, 20 * 60 + 30);
  addBreak(21 * 60 + 30, 21 * 60 + 40);

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
 * Reconstructs a single non-overlapping status timeline from a set of status_logs rows, clips it
 * to [windowStart, windowEnd], subtracts any overlap with the given planned breaks, and buckets
 * the remaining duration into Running/Stopped/Not Connected totals (plus downtime-by-reason).
 * Shared by the live "since midnight" calculation below and reportingService.js's arbitrary
 * historical windows, so the two can never compute utilization differently.
 *
 * status_logs rows are sometimes left with a NULL end_time when a transition wasn't closed out
 * properly (e.g. a dropped connection racing the next status change). Summed naively, such a row
 * counts as Running/Stopped forever - including bleeding into every later shift's window, and
 * stacking on top of whatever legitimately runs there - which is what let Operating Time inflate
 * to match (or exceed) Planned Production Time and made Downtime read 0 even on shifts with real
 * stoppages. Fix: sort all rows by their ORIGINAL start_time and truncate each one's effective
 * end at the start of the next chronologically distinct row - a later transition always
 * supersedes an earlier, still-"open" one. Rows sharing the exact same start_time (legitimate
 * simultaneous companions, e.g. 'Stopped' + 'Not Connected' logged together for one disconnect)
 * are left alone rather than truncating each other.
 */
export function aggregateStatusLogs(logs, windowStart, windowEnd, breaks) {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();

  const originals = logs
    .map((log) => ({
      start: new Date(log.start_time).getTime(),
      end: log.end_time ? new Date(log.end_time).getTime() : Infinity,
      status: log.status,
      reason: log.downtime_reason
    }))
    .sort((a, b) => a.start - b.start);

  const distinctStarts = [...new Set(originals.map((l) => l.start))];
  const nextDistinctStart = (t) => {
    let best = Infinity;
    for (const s of distinctStarts) {
      if (s > t && s < best) best = s;
    }
    return best;
  };

  const resolved = originals
    .map((l) => ({
      start: Math.max(l.start, winStart),
      end: Math.min(l.end, nextDistinctStart(l.start), winEnd),
      status: l.status,
      reason: l.reason
    }))
    .filter((l) => l.end > l.start);

  let runningSeconds = 0;
  let stoppedSeconds = 0;
  let noSignalSeconds = 0;

  const downtimeReasons = {};
  PREDEFINED_REASONS.forEach(r => downtimeReasons[r] = 0);

  resolved.forEach((iv) => {
    const ivStart = new Date(iv.start);
    const ivEnd = new Date(iv.end);
    let overlapSeconds = 0;
    breaks.forEach(b => {
      overlapSeconds += getIntervalOverlapSeconds(ivStart, ivEnd, b.start, b.end);
    });
    const durationSeconds = Math.max(0, (iv.end - iv.start) / 1000 - overlapSeconds);

    if (iv.status === 'Running') {
      runningSeconds += durationSeconds;
    } else if (iv.status === 'Stopped') {
      stoppedSeconds += durationSeconds;
      // Group by reason if available
      const reason = iv.reason || 'Other';
      if (downtimeReasons[reason] !== undefined) {
        downtimeReasons[reason] += durationSeconds;
      } else {
        downtimeReasons['Other'] += durationSeconds;
      }
    } else if (iv.status === 'Not Connected') {
      noSignalSeconds += durationSeconds;
    }
  });

  // Break time is credited once per unique resolved (start, end) interval, not once per row that
  // shares it - a 'Stopped' + 'Not Connected' companion pair covering the same disconnect must
  // not subtract the same break minute from Planned Production Time twice.
  const uniqueIntervals = new Map();
  resolved.forEach((iv) => {
    uniqueIntervals.set(`${iv.start}-${iv.end}`, iv);
  });
  let breakSeconds = 0;
  uniqueIntervals.forEach((iv) => {
    const ivStart = new Date(iv.start);
    const ivEnd = new Date(iv.end);
    breaks.forEach(b => {
      breakSeconds += getIntervalOverlapSeconds(ivStart, ivEnd, b.start, b.end);
    });
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
 * Automatic production target for one scheduled part_schedules entry - the single formula
 * behind "PPC never manually enters a target quantity":
 *
 *   Effective Cycle Time = Ideal Cycle Time + Loading/Unloading Allowance (both typed directly
 *                           by the PPC Engineer on this entry - no catalog, no global default)
 *   Available Time       = the entry's own [planned_start, planned_end) window, minus any
 *                           planned break (Tea/Lunch/Dinner) that falls inside it
 *   Target                = floor(Available Time / Effective Cycle Time)
 *
 * Uses the entry's OWN window, not the whole shift - this is what makes multiple sequential
 * parts within one shift (e.g. 08:00-12:00 Part A, 13:00-17:00 Part B) each get their own
 * independently-correct target with zero shared state between them. Math.floor, never round up -
 * a target the available time can't actually fit would be a promise the shift can't keep.
 */
export function calculateAutoTarget({ planDate, plannedStart, plannedEnd, idealCycleTime, loadUnloadAllowanceSeconds }) {
  const entryStart = buildPlantDateTime(planDate, plannedStart);
  let entryEnd = buildPlantDateTime(planDate, plannedEnd);
  // A window ending at midnight (e.g. Shift B's planned_end stored as "00:00:00") means midnight
  // of the FOLLOWING day, not the start of planDate itself - roll it forward a day so the
  // duration comes out positive instead of clamping to 0 available seconds.
  if (entryEnd.getTime() <= entryStart.getTime()) {
    entryEnd = new Date(entryEnd.getTime() + 24 * 3600000);
  }
  const midnight = getShiftWindow(planDate, 'Shift C').start;
  const breaks = getPlannedBreaks(midnight);
  const breakSeconds = breaks.reduce((s, b) => s + getIntervalOverlapSeconds(entryStart, entryEnd, b.start, b.end), 0);
  const availableSeconds = Math.max(0, (entryEnd.getTime() - entryStart.getTime()) / 1000 - breakSeconds);
  const effectiveCycleTime = idealCycleTime + loadUnloadAllowanceSeconds;
  const target = effectiveCycleTime > 0 ? Math.floor(availableSeconds / effectiveCycleTime) : 0;

  return { availableSeconds, effectiveCycleTime, target };
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

    // A machine with no ESP32/Raspberry Pi wired up (iot_enabled = FALSE) - or one that IS
    // wired up but has lost signal past its heartbeat timeout (status forced to 'Not Connected'
    // by the watchdog, see watchdogService.js) - must never report a fabricated Running/Stopped/
    // OEE reading. `null`, not 0, so callers can tell "genuinely 0%" apart from "not applicable"
    // and know to suppress the gauge/meters entirely rather than render a misleading percentage.
    if (!machine.iot_enabled || machine.status === 'Not Connected') {
      return {
        connected: false,
        availability: null,
        performance: null,
        quality: null,
        oee: null,
        downtimeSeconds: null,
        shiftElapsedSeconds: null,
        machineUtilization: null,
        lastCycleTime: null,
        currentShift: getShiftForTimestamp(now),
        shifts: { A: 0, B: 0, C: 0 },
        utilization: null,
        downtimeReasons: null
      };
    }

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
