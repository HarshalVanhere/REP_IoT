import db from '../config/db.js';
import { PREDEFINED_REASONS, PLANNED_REASONS } from '../config/reasonCodes.js';
import { getShiftForTimestamp, getCurrentShiftStart, getShiftWindow, buildPlantDateTime, toDateOnlyString } from '../config/shifts.js';

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
 * Reconstructs a single non-overlapping status timeline from a set of status_logs rows, clipped
 * to [windowStart, windowEnd]. Shared by aggregateStatusLogs below AND reportingService.js's
 * buildDowntimeReport, so the Downtime Analysis event list and every downtime/uptime total
 * derived from status_logs (OEE Report included) are always built from the exact same resolved
 * intervals - the single fix point for "overlapping downtime events double-counted".
 *
 * status_logs rows are sometimes left with a NULL end_time when a transition wasn't closed out
 * properly (e.g. a dropped connection racing the next status change), and duplicate-insert bugs
 * have historically left genuinely overlapping rows for the same machine. Summed naively, such
 * rows count as Running/Stopped forever - including bleeding into every later shift's window, and
 * stacking on top of whatever legitimately runs there, or double-counting the same wall-clock
 * downtime twice. Fix: sort all rows by their ORIGINAL start_time and truncate each one's
 * effective end at the start of the next chronologically distinct row - a later transition always
 * supersedes an earlier, still-"open" or overlapping one. Rows sharing the exact same start_time
 * with DIFFERENT statuses (legitimate simultaneous companions, e.g. 'Stopped' + 'Not Connected'
 * logged together for one disconnect) are left alone rather than truncating each other. Rows
 * sharing both the same start_time AND the same status - the signature of a duplicate-insert
 * race, not a real companion pair - are collapsed into one interval instead of each contributing
 * their own full duration, otherwise that single stoppage would count as downtime twice.
 */
export function resolveStatusIntervals(logs, windowStart, windowEnd) {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();

  const deduped = new Map();
  for (const log of logs) {
    const start = new Date(log.start_time).getTime();
    const end = log.end_time ? new Date(log.end_time).getTime() : Infinity;
    // A stored end_time at or before its own start_time is corrupt data (a historical race/bug
    // artifact, confirmed in production: a handful of rows with end_time minutes BEFORE
    // start_time). Such a row has no valid duration and must be excluded entirely - not just from
    // contributing an interval (already handled by the end>start filter below) but from
    // `distinctStarts` too. Left in, its mere start_time could still poison nextDistinctStart's
    // truncation of a genuinely earlier, legitimate row - e.g. silently deleting an open Running
    // interval that should have carried into this shift, because a corrupt row's start_time
    // looked like "the next real transition" even though the row itself is garbage.
    if (log.end_time && end <= start) continue;
    const key = `${start}|${log.status}`;
    const existing = deduped.get(key);
    // Keep the row with the LATEST effective end (Infinity/still-open wins) - a duplicate that
    // never got closed out is the one that reflects this interval's true extent.
    if (!existing || end > existing.end) {
      deduped.set(key, {
        id: log.id,
        start,
        end,
        status: log.status,
        reason: log.downtime_reason,
        operator: log.operator_id,
        partName: log.part_name
      });
    }
  }

  const originals = [...deduped.values()].sort((a, b) => a.start - b.start);

  const distinctStarts = [...new Set(originals.map((l) => l.start))];
  const nextDistinctStart = (t) => {
    let best = Infinity;
    for (const s of distinctStarts) {
      if (s > t && s < best) best = s;
    }
    return best;
  };

  const truncated = originals
    .map((l) => ({
      id: l.id,
      start: Math.max(l.start, winStart),
      end: Math.min(l.end, nextDistinctStart(l.start), winEnd),
      status: l.status,
      reason: l.reason,
      operator: l.operator,
      partName: l.partName
    }))
    .filter((l) => l.end > l.start);

  // Two rows spanning the EXACT same (start, end) with DIFFERENT non-Running statuses (real
  // production data: a race that logged the same disconnect as both 'Stopped' AND 'Not
  // Connected') are the same real-world outage described twice, not two independent concurrent
  // downtime periods - counting both in full double-counts that wall-clock time. Collapse any
  // such exact-span group down to a single interval, preferring 'Stopped' (carries an operator
  // reason, the more specific classification) over 'Not Connected'. A genuine companion pair with
  // staggered (non-identical) start/end is untouched - only a fully coincident span collapses.
  const bySpan = new Map();
  truncated.forEach((iv) => {
    const key = `${iv.start}-${iv.end}`;
    if (!bySpan.has(key)) bySpan.set(key, []);
    bySpan.get(key).push(iv);
  });

  const result = [];
  bySpan.forEach((group) => {
    if (group.length === 1) {
      result.push(group[0]);
      return;
    }
    const running = group.find((iv) => iv.status === 'Running');
    if (running) {
      result.push(running);
      return;
    }
    const stopped = group.find((iv) => iv.status === 'Stopped');
    result.push(stopped || group[0]);
  });

  return result.sort((a, b) => a.start - b.start);
}

/**
 * Fills every uncovered gap in a resolved (non-overlapping) interval list so the returned
 * timeline covers [windowStart, windowEnd) with ZERO holes. status_logs can have genuine holes -
 * a machine that was iot_enabled mid-shift with no prior row, a historical logging gap, a period
 * that simply never got a status_logs row at all - and summing only the rows that exist silently
 * drops that time from every total (Running/Downtime both), which is exactly the "lost minutes"
 * bug this closes. Gaps are inserted as synthetic Stopped intervals (id: null, reason: null,
 * synthetic: true) - unclassified wall-clock time is downtime by definition (it is provably not
 * Running), and computeShiftDowntime below assigns it a concrete reason.
 */
function fillTimelineGaps(resolved, windowStart, windowEnd) {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();
  if (winEnd <= winStart) return [];

  const timeline = [];
  let cursor = winStart;
  for (const iv of resolved) {
    if (iv.start > cursor) {
      timeline.push({ id: null, start: cursor, end: iv.start, status: 'Stopped', reason: null, operator: null, partName: null, synthetic: true });
    }
    timeline.push(iv);
    cursor = Math.max(cursor, iv.end);
  }
  if (cursor < winEnd) {
    timeline.push({ id: null, start: cursor, end: winEnd, status: 'Stopped', reason: null, operator: null, partName: null, synthetic: true });
  }
  return timeline;
}

/**
 * THE single per-minute classified timeline for one [windowStart, windowEnd) window - every
 * caller that needs to reason about status minute-by-minute (computeShiftDowntime's totals below,
 * AND reportingService.js's buildHourlyBreakdown slicing that same shift into hour buckets) reads
 * off this SAME classified timeline, never re-derives their own. Covers [windowStart, windowEnd)
 * with zero gaps and zero overlaps (resolveStatusIntervals + fillTimelineGaps), and every non-
 * Running interval already carries its final reason - see computeShiftDowntime's docblock below
 * for the exact classification rules (whole-window-never-ran, pre-first-run gaps, Not Connected,
 * specific reasons preserved). Running intervals carry reason/category: null - not applicable.
 */
export function buildClassifiedTimeline(logs, windowStart, windowEnd) {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();
  if (winEnd <= winStart) return [];

  const resolved = resolveStatusIntervals(logs, windowStart, windowEnd);
  const timeline = fillTimelineGaps(resolved, windowStart, windowEnd);

  const firstRunningStart = timeline
    .filter((iv) => iv.status === 'Running')
    .reduce((min, iv) => (min === null || iv.start < min ? iv.start : min), null);
  const everRan = firstRunningStart !== null;

  return timeline
    .map((iv) => {
      const durationSeconds = Math.max(0, (iv.end - iv.start) / 1000);
      if (durationSeconds <= 0) return null;

      if (iv.status === 'Running') {
        return {
          id: iv.id,
          start: new Date(iv.start),
          end: new Date(iv.end),
          status: 'Running',
          reason: null,
          category: null,
          durationSeconds,
          operator: iv.operator,
          partName: iv.partName,
          synthetic: !!iv.synthetic
        };
      }

      let reason;
      if (!everRan) {
        // Nothing ran anywhere in this window - the whole thing is an unstarted shift, full stop.
        reason = 'No Shift Started';
      } else {
        const beforeFirstRun = iv.end <= firstRunningStart;
        reason = iv.reason;
        if (!reason) {
          reason = beforeFirstRun
            ? 'No Shift Started'
            : (iv.status === 'Not Connected' ? 'No Signal' : 'Other');
        } else if (reason === 'Shift Start' && beforeFirstRun) {
          reason = 'No Shift Started';
        }
      }

      return {
        id: iv.id,
        start: new Date(iv.start),
        end: new Date(iv.end),
        status: iv.status,
        reason,
        category: PLANNED_REASONS.has(reason) ? 'Planned' : 'Unplanned',
        durationSeconds,
        operator: iv.operator,
        partName: iv.partName,
        synthetic: !!iv.synthetic
      };
    })
    .filter(Boolean);
}

/**
 * THE single source of truth for downtime TOTALS, for exactly one [windowStart, windowEnd) window
 * (one shift, or any other bounded period) - a thin aggregation over buildClassifiedTimeline
 * above. Both aggregateStatusLogs below (live dashboard + the OEE Report's per-shift totals) and
 * reportingService.js's buildDowntimeReport (Downtime Analysis' event list) call this same
 * function for the same window, so the two can never disagree about Total Downtime - there is no
 * second, parallel implementation of this math anywhere else.
 *
 * Guarantees, by construction:
 *   - Every minute of [windowStart, windowEnd) is accounted for exactly once: resolveStatusIntervals
 *     removes overlaps, fillTimelineGaps removes holes, so runningSeconds + totalDowntimeSeconds
 *     always equals the window's full duration - Total Shift Time = Operating Time + Total
 *     Downtime holds as an identity, not an approximation.
 *   - Every non-Running interval (Stopped, Not Connected, or an unlogged gap) gets a concrete
 *     reason - never left blank, never silently dropped from the reasons breakdown.
 *   - A window with zero Running activity anywhere in it - the machine never started this shift -
 *     has its ENTIRE downtime classified as 'No Shift Started', regardless of whatever specific
 *     reason (if any) individual rows happen to carry, matching that concept literally: nothing
 *     ran, so there is nothing else meaningful to attribute the time to.
 *   - Otherwise, only the time BEFORE the shift's first real Running interval is eligible for
 *     'No Shift Started' (a late start), and only when it carries no more specific reason already
 *     (an operator-logged reason for the delay, e.g. 'Material Shortage', is left untouched -
 *     losing real diagnostic input would violate "do not hide/discard downtime duration" too).
 *   - Scheduled-break overlap is NEVER subtracted from a downtime interval's counted duration
 *     (the previous behavior did this for non-break reasons) - doing so silently erased real
 *     downtime minutes from the reasons breakdown and Total Downtime. breakSeconds is still
 *     computed and returned, but only for Planned Production Time (Availability's denominator),
 *     a separate, deliberately break-excluded figure this function does not otherwise use.
 *
 * IMPORTANT: classification (e.g. 'No Shift Started') is scoped to whatever window YOU pass in -
 * always call this with the FULL shift window, never a sub-slice of it (e.g. one hour), or a
 * mid-shift downtime blip in that one hour will be wrongly read as "the shift never started".
 * buildHourlyBreakdown avoids this by classifying the whole shift once via buildClassifiedTimeline
 * and slicing the already-classified result into hours, rather than calling this per hour.
 */
export function computeShiftDowntime(logs, windowStart, windowEnd, breaks) {
  if (windowEnd.getTime() <= windowStart.getTime()) {
    return { runningSeconds: 0, totalDowntimeSeconds: 0, downtimeReasons: {}, downtimeEvents: [], breakSeconds: 0 };
  }

  const timeline = buildClassifiedTimeline(logs, windowStart, windowEnd);

  let runningSeconds = 0;
  let totalDowntimeSeconds = 0;
  const downtimeReasons = {};
  const downtimeEvents = [];

  timeline.forEach((iv) => {
    if (iv.status === 'Running') {
      runningSeconds += iv.durationSeconds;
      return;
    }
    totalDowntimeSeconds += iv.durationSeconds;
    downtimeReasons[iv.reason] = (downtimeReasons[iv.reason] || 0) + iv.durationSeconds;
    downtimeEvents.push(iv);
  });

  // Planned Production Time's break exclusion is a SEPARATE concept from downtime accounting
  // above - credited once per unique (start, end) span (including gap-filled ones) so a
  // 'Stopped' + 'Not Connected' companion pair covering the same disconnect doesn't subtract the
  // same break minute twice.
  const uniqueSpans = new Map();
  timeline.forEach((iv) => uniqueSpans.set(`${iv.start.getTime()}-${iv.end.getTime()}`, iv));
  let breakSeconds = 0;
  uniqueSpans.forEach((iv) => {
    breaks.forEach((b) => {
      breakSeconds += getIntervalOverlapSeconds(iv.start, iv.end, b.start, b.end);
    });
  });

  return { runningSeconds, totalDowntimeSeconds, downtimeReasons, downtimeEvents, breakSeconds };
}

/**
 * Legacy-shaped wrapper around computeShiftDowntime, preserving the {runningSeconds,
 * stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons} contract every existing caller
 * (the live "since shift start" dashboard, reportingService.js's OEE Report, the Analytics
 * hourly-trend chart) already depends on, plus the new totalDowntimeSeconds field. Not Connected
 * time and gap-filled time both used to be invisible to "downtime" (only 'Stopped' rows counted) -
 * they're now folded into stoppedSeconds/totalDowntimeSeconds too (noSignalSeconds is still
 * broken out separately for callers that render a distinct "No Signal" utilization bar), since a
 * machine that's disconnected or has an unlogged gap is not producing either way.
 */
export function aggregateStatusLogs(logs, windowStart, windowEnd, breaks) {
  const { runningSeconds, totalDowntimeSeconds, downtimeReasons, downtimeEvents, breakSeconds } =
    computeShiftDowntime(logs, windowStart, windowEnd, breaks);

  let stoppedSeconds = 0;
  let noSignalSeconds = 0;
  downtimeEvents.forEach((e) => {
    if (e.status === 'Not Connected') noSignalSeconds += e.durationSeconds;
    else stoppedSeconds += e.durationSeconds;
  });

  return { runningSeconds, stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons, totalDowntimeSeconds };
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
  // CRITICAL FIX: this used to be `new Date(); midnight.setHours(0, 0, 0, 0)`, which builds
  // midnight in the NODE PROCESS's own local timezone (.setHours operates in local time), not
  // the plant's. On a machine whose local dev TZ happens to already be Asia/Kolkata this is a
  // silent no-op, which is exactly why it went unnoticed - but a cloud host (Railway, etc.)
  // commonly runs its OS clock in UTC, which shifts this "midnight" by the full IST offset
  // (5:30). getPlannedBreaks(midnight) below builds the Tea/Lunch/Dinner windows off this value,
  // so every break window - and therefore breakSeconds, and therefore downtimeSeconds/
  // availability on the LIVE dashboard - silently misaligns by 5:30 on such a host, while
  // reportingService.js's historical reports stay correct because they already build midnight
  // via the plant-timezone-safe getShiftWindow() helper (see shifts.js's own comment on exactly
  // this failure mode). Matching that same helper here is what actually fixes it.
  const midnight = getShiftWindow(toDateOnlyString(now), 'Shift C').start;
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
    const { runningSeconds, stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons, totalDowntimeSeconds } =
      aggregateStatusLogs(logs, shiftStart, now, todayBreaks);

    // Shift Elapsed Time = now - shift start (raw, includes planned breaks)
    const shiftElapsedSeconds = Math.max(0, (now.getTime() - shiftStart.getTime()) / 1000);
    // Planned Production Time = Shift Elapsed - Planned Break Elapsed. Used ONLY as Availability's
    // denominator below - Total Downtime (totalDowntimeSeconds, from aggregateStatusLogs) is a
    // separate, gap-filled figure covering the FULL shift-elapsed time, matching the Downtime
    // Analysis/OEE Report definition: Total Shift Time = Operating Time + Total Downtime.
    const plannedSeconds = Math.max(1, shiftElapsedSeconds - breakSeconds);

    const runningPct = Math.max(0, Math.min(100, (runningSeconds / plannedSeconds) * 100));
    const stoppedPct = Math.max(0, Math.min(100, (stoppedSeconds / plannedSeconds) * 100));
    const noSignalPct = Math.max(0, Math.min(100, (noSignalSeconds / plannedSeconds) * 100));

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
