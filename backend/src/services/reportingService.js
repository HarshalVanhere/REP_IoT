import db from '../config/db.js';
import { SHIFT_NAMES, getShiftWindow, buildPlantDateTime, formatPlantTime } from '../config/shifts.js';
import { getPlannedBreaks, aggregateStatusLogs, computeOeeFromTotals, getIntervalOverlapSeconds, calculateAutoTarget } from './oeeCalculator.js';

// Downtime reasons treated as "Planned" for the Downtime Analysis module's Planned/Unplanned
// split - everything else in PREDEFINED_REASONS (config/reasonCodes.js) is Unplanned.
const PLANNED_REASONS = new Set([
  'Tea Break',
  'Lunch Break',
  'Preventive Maintenance'
]);

const round1 = (n) => Math.round((n || 0) * 10) / 10;

/**
 * Inclusive list of 'YYYY-MM-DD' calendar-date strings between startDate and endDate.
 * Pure string/UTC arithmetic - these are calendar-date labels, not instants, so no plant
 * timezone conversion is needed here (that happens later, in getShiftWindow).
 */
function dateRange(startDate, endDate) {
  const dates = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    dates.push(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return dates;
}

function isoWeekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const target = new Date(d.valueOf());
  const dayNr = (d.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const weekNumber = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-W${String(weekNumber).padStart(2, '0')}`;
}

/**
 * Fetches pulses for a machine clipped to [windowStart, windowEnd). Mock DB mode has no
 * range-filtering SQL support, so it fetches the (small, seeded) full set and filters in JS -
 * the same db.isMock branching pattern already used throughout oeeCalculator.js/mqttService.js.
 * The real-MySQL path uses the range predicate directly, benefiting from the new
 * idx_pulses_machine_timestamp index.
 */
async function fetchPulsesInRange(machineId, windowStart, windowEnd) {
  if (db.isMock) {
    const [pulses] = await db.query('SELECT * FROM pulses WHERE machine_id = ?', [machineId]);
    return pulses.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return t >= windowStart.getTime() && t < windowEnd.getTime();
    });
  }
  const [pulses] = await db.query(
    'SELECT id, timestamp, cycle_time, is_good, part_schedule_id FROM pulses WHERE machine_id = ? AND timestamp >= ? AND timestamp < ? ORDER BY timestamp ASC',
    [machineId, windowStart, windowEnd]
  );
  return pulses;
}


/**
 * Fetches status_logs overlapping [windowStart, windowEnd) for a machine (same mock/real
 * branching as fetchPulsesInRange, benefiting from idx_status_logs_machine_start on real MySQL).
 */
async function fetchStatusLogsOverlapping(machineId, windowStart, windowEnd) {
  if (db.isMock) {
    const [logs] = await db.query('SELECT * FROM status_logs WHERE machine_id = ?', [machineId]);
    return logs.filter((l) => {
      const s = new Date(l.start_time).getTime();
      const e = l.end_time ? new Date(l.end_time).getTime() : Infinity;
      return s < windowEnd.getTime() && e > windowStart.getTime();
    });
  }
  const [logs] = await db.query(
    `SELECT id, status, start_time, end_time, downtime_reason, operator_id, part_name
     FROM status_logs
     WHERE machine_id = ? AND start_time < ? AND (end_time IS NULL OR end_time > ?)
     ORDER BY start_time ASC`,
    [machineId, windowEnd, windowStart]
  );
  return logs;
}

/**
 * Reads part_schedules for one (machine, date, shift) to get the scheduled target, ideal cycle
 * time, operator(s), and active part name - the same table/attribution partSchedules.js's
 * computeActualForEntry() already trusts. Falls back to the machine's own defaults when nothing
 * was scheduled for that shift (machine ran "unscheduled").
 */
function deriveShiftMeta(entries, machineDefault = {}) {
  if (entries.length === 0) {
    return {
      target: 0,
      idealCycleTime: machineDefault.ideal_cycle_time || 15,
      operator: machineDefault.assigned_operator || null,
      partName: null,
      partScheduleIds: [],
      scheduled: false
    };
  }

  const target = entries.reduce((sum, e) => sum + (e.target || 0), 0);
  const operators = [...new Set(entries.map((e) => e.operator).filter(Boolean))];
  const parts = [...new Set(entries.map((e) => e.part_name).filter(Boolean))];
  const primary = entries.find((e) => e.status === 'Running') || entries.find((e) => e.status === 'Completed') || entries[0];

  return {
    target,
    idealCycleTime: primary.ideal_cycle_time,
    operator: operators.length > 0 ? operators.join(', ') : null,
    partName: parts.length > 0 ? parts.join(', ') : null,
    partScheduleIds: entries.map((e) => e.id),
    scheduled: true
  };
}

export async function getShiftMeta(machineId, dateStr, shiftName) {
  const [entries] = await db.query(
    'SELECT * FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ? ORDER BY sequence ASC',
    [machineId, dateStr, shiftName]
  );

  if (entries.length === 0) {
    const [machines] = await db.query(
      'SELECT ideal_cycle_time, active_part_name, assigned_operator FROM machines WHERE id = ?',
      [machineId]
    );
    return deriveShiftMeta([], machines[0] || {});
  }

  return deriveShiftMeta(entries);
}

/**
 * Computes the same Availability/Performance/Quality/OEE (and supporting totals) as the live
 * dashboard, but for an arbitrary [windowStart, windowEnd) instead of "since midnight" - reuses
 * aggregateStatusLogs/computeOeeFromTotals from oeeCalculator.js so there is exactly one
 * implementation of the formulas.
 */
export async function computeWindowMetrics(machineId, dateStr, windowStart, windowEnd, {
  idealCycleTime, partScheduleIds, machineIdealCycleTime, statusLogs: preStatusLogs, pulses: prePulses
} = {}) {
  const now = new Date();
  const effectiveEnd = windowEnd.getTime() > now.getTime() ? now : windowEnd;
  const clippedEnd = effectiveEnd.getTime() < windowStart.getTime() ? windowStart : effectiveEnd;

  let effectiveIdealCycleTime = idealCycleTime;
  if (effectiveIdealCycleTime == null) {
    if (machineIdealCycleTime != null) {
      effectiveIdealCycleTime = machineIdealCycleTime;
    } else {
      const [machines] = await db.query('SELECT ideal_cycle_time FROM machines WHERE id = ?', [machineId]);
      effectiveIdealCycleTime = machines[0]?.ideal_cycle_time || 15;
    }
  }

  // When the caller already bulk-fetched statusLogs for a wider range (see buildOeeReportRows),
  // reuse that array in-memory instead of re-querying the DB per shift - avoids one network
  // round-trip per (date x shift) against a remote MySQL host.
  const allStatusLogs = preStatusLogs || await fetchStatusLogsOverlapping(machineId, windowStart, clippedEnd);

  // aggregateStatusLogs gets the WIDER set (not narrowed to this window's overlap): it needs
  // visibility into rows outside the window - e.g. an earlier still-open row's chronologically-
  // next neighbor - to correctly truncate a row that was never properly closed, instead of
  // letting it bleed into this window. The row-scoped `statusLogs` returned below (used for the
  // "View Details" timeline) stays narrowed to just this window's overlap, same as before.
  const statusLogs = allStatusLogs.filter((l) => {
    const s = new Date(l.start_time).getTime();
    const e = l.end_time ? new Date(l.end_time).getTime() : Infinity;
    return s < clippedEnd.getTime() && e > windowStart.getTime();
  });

  let pulses = prePulses
    ? prePulses.filter((p) => {
        const t = new Date(p.timestamp).getTime();
        return t >= windowStart.getTime() && t < clippedEnd.getTime();
      })
    : await fetchPulsesInRange(machineId, windowStart, clippedEnd);

  if (partScheduleIds && partScheduleIds.length > 0) {
    const idSet = new Set(partScheduleIds);
    pulses = pulses.filter((p) => idSet.has(p.part_schedule_id));
  }

  // The shift/day windows this function is ever called with always fall within a single plant
  // calendar day (Shift C 00:00-07:00, A 07:00-15:30, B 15:30-24:00, "day" = the union of all
  // three) - one getPlannedBreaks(midnight) call per dateStr covers the whole window.
  const midnight = getShiftWindow(dateStr, 'Shift C').start;
  const breaks = getPlannedBreaks(midnight);

  const { runningSeconds, stoppedSeconds, noSignalSeconds, breakSeconds, downtimeReasons } =
    aggregateStatusLogs(allStatusLogs, windowStart, clippedEnd, breaks);

  const totalWindowSeconds = Math.max(0, (clippedEnd.getTime() - windowStart.getTime()) / 1000);
  const plannedSeconds = Math.max(1, totalWindowSeconds - breakSeconds);

  // Operating Time = actual Running Time, not a residual of Stopped/No-Signal logs - a window
  // with no status_logs rows at all (machine never ran) must show zero Operating Time and full
  // downtime, not the other way around. Downtime is then derived FROM Running Time.
  const operatingSeconds = Math.min(runningSeconds, plannedSeconds);
  const totalDowntimeSeconds = Math.max(0, plannedSeconds - operatingSeconds);

  // Machine Utilization = Running Time / raw window duration (includes breaks) - distinct from
  // Availability below, which uses Planned Production Time (break-excluded) as its denominator.
  const windowUtilization = totalWindowSeconds > 0
    ? Math.max(0, Math.min(100, (runningSeconds / totalWindowSeconds) * 100))
    : 0;

  const totalCount = pulses.length;
  const goodCount = pulses.filter((p) => p.is_good === 1 || p.is_good === true).length;
  const rejectCount = totalCount - goodCount;

  const { availability, performance, quality, oee } = computeOeeFromTotals({
    plannedSeconds,
    operatingSeconds,
    totalCount,
    goodCount,
    idealCycleTime: effectiveIdealCycleTime
  });

  return {
    plannedSeconds,
    totalWindowSeconds,
    windowUtilization,
    operatingSeconds,
    runningSeconds,
    stoppedSeconds,
    noSignalSeconds,
    breakSeconds,
    totalDowntimeSeconds,
    totalCount,
    goodCount,
    rejectCount,
    idealCycleTime: effectiveIdealCycleTime,
    avgCycleTime: totalCount > 0 ? operatingSeconds / totalCount : 0,
    availability,
    performance,
    quality,
    oee,
    downtimeReasons,
    statusLogs,
    pulses
  };
}

/**
 * Collapses an array of per-shift rows (same calendar date) into one per-day row, re-deriving
 * Availability/Performance/Quality/OEE from the summed totals rather than averaging percentages.
 */
function collapseByDay(shiftRows) {
  const byDate = new Map();
  for (const row of shiftRows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const collapsed = [];
  for (const [date, rows] of byDate) {
    const sumField = (field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
    const plannedSeconds = sumField('plannedSeconds');
    const totalWindowSeconds = sumField('totalWindowSeconds');
    const operatingSeconds = sumField('operatingSeconds');
    const totalCount = sumField('totalCount');
    const goodCount = sumField('goodCount');
    const rejectCount = sumField('rejectCount');
    const target = sumField('target');

    const idealCycleTimes = [...new Set(rows.map((r) => r.idealCycleTime))];
    const idealCycleTime = idealCycleTimes.length === 1 ? idealCycleTimes[0] : (totalCount > 0 ? operatingSeconds / totalCount : idealCycleTimes[0]);

    const operators = [...new Set(rows.map((r) => r.operator).filter(Boolean))];
    const parts = [...new Set(rows.map((r) => r.partName).filter(Boolean))];

    const downtimeReasons = {};
    rows.forEach((r) => {
      Object.entries(r.downtimeReasons || {}).forEach(([reason, seconds]) => {
        downtimeReasons[reason] = (downtimeReasons[reason] || 0) + seconds;
      });
    });

    const { availability, performance, quality, oee } = computeOeeFromTotals({
      plannedSeconds, operatingSeconds, totalCount, goodCount, idealCycleTime
    });

    collapsed.push({
      date,
      shift: rows.length === 1 ? rows[0].shift : 'All Shifts',
      operator: operators.join(', ') || null,
      partName: parts.join(', ') || null,
      target,
      idealCycleTime: round1(idealCycleTime),
      plannedSeconds,
      totalWindowSeconds,
      windowUtilization: round1(totalWindowSeconds > 0 ? (sumField('runningSeconds') / totalWindowSeconds) * 100 : 0),
      operatingSeconds,
      runningSeconds: sumField('runningSeconds'),
      stoppedSeconds: sumField('stoppedSeconds'),
      noSignalSeconds: sumField('noSignalSeconds'),
      breakSeconds: sumField('breakSeconds'),
      totalDowntimeSeconds: sumField('totalDowntimeSeconds'),
      totalCount,
      goodCount,
      rejectCount,
      avgCycleTime: totalCount > 0 ? operatingSeconds / totalCount : 0,
      availability: round1(availability),
      performance: round1(performance),
      quality: round1(quality),
      oee: round1(oee),
      downtimeReasons
    });
  }

  return collapsed.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Recomputes the whole filtered row-set's overall KPI totals (never averages percentages -
 * always re-derives Availability/Performance/Quality/OEE from the summed seconds/counts).
 */
function summarizeKpis(rows, machineId, machineName, startDate, endDate) {
  const sumField = (field) => rows.reduce((s, r) => s + (r[field] || 0), 0);
  const plannedSeconds = sumField('plannedSeconds');
  const totalWindowSeconds = sumField('totalWindowSeconds');
  const operatingSeconds = sumField('operatingSeconds');
  const totalCount = sumField('totalCount');
  const goodCount = sumField('goodCount');
  const rejectCount = sumField('rejectCount');
  const target = sumField('target');
  const runningSeconds = sumField('runningSeconds');
  const stoppedSeconds = sumField('stoppedSeconds');
  const noSignalSeconds = sumField('noSignalSeconds');
  const breakSeconds = sumField('breakSeconds');
  const totalDowntimeSeconds = sumField('totalDowntimeSeconds');

  const idealCycleTimes = [...new Set(rows.map((r) => r.idealCycleTime).filter((v) => v != null))];
  const idealCycleTime = idealCycleTimes.length === 1
    ? idealCycleTimes[0]
    : (totalCount > 0 ? operatingSeconds / totalCount : (idealCycleTimes[0] || 0));

  const { availability, performance, quality, oee } = computeOeeFromTotals({
    plannedSeconds, operatingSeconds, totalCount, goodCount, idealCycleTime
  });

  const operatingHours = operatingSeconds / 3600;
  const actualCycleTime = totalCount > 0 ? operatingSeconds / totalCount : 0;

  return {
    machineId,
    machineName,
    startDate,
    endDate,
    plannedProductionSeconds: plannedSeconds,
    totalWindowSeconds,
    operatingSeconds,
    runningSeconds,
    stoppedSeconds,
    noSignalSeconds,
    breakSeconds,
    totalDowntimeSeconds,
    goodCount,
    rejectCount,
    totalCount,
    target,
    idealCycleTime: round1(idealCycleTime),
    avgCycleTime: actualCycleTime,
    actualCycleTime,
    availability: round1(availability),
    performance: round1(performance),
    quality: round1(quality),
    oee: round1(oee),
    // Utilization = Running Time / raw window duration (includes breaks) - intentionally NOT the
    // same formula as Availability (which divides by break-excluded Planned Production Time).
    machineUtilization: round1(totalWindowSeconds > 0 ? (operatingSeconds / totalWindowSeconds) * 100 : 0),
    productionAchievement: target > 0 ? round1((totalCount / target) * 100) : null,
    rejectionPercent: totalCount > 0 ? round1((rejectCount / totalCount) * 100) : 0,
    yieldPercent: totalCount > 0 ? round1((goodCount / totalCount) * 100) : 100,
    rejectPpm: totalCount > 0 ? Math.round((rejectCount / totalCount) * 1000000) : 0,
    avgHourlyProduction: operatingHours > 0 ? round1(totalCount / operatingHours) : 0
  };
}

/**
 * Builds the Machine-Wise OEE Report's rows + KPIs for a machine over [startDate, endDate].
 * Walks every (date, shift) in range, attributes production via part_schedules
 * (getShiftMeta), computes each shift's metrics (computeWindowMetrics), optionally collapses to
 * one row per day, and applies operator/part filters. A single-date/single-shift call (as used
 * by GET /api/reports/oee-detail) is just this same function with startDate === endDate and
 * shift set - there is no separate calculation path for the drill-down.
 */
export async function buildOeeReportRows(machineId, startDate, endDate, { shift, operator, partName, groupBy, includeRaw = false } = {}) {
  const shiftsToWalk = shift ? [shift] : SHIFT_NAMES;
  const dates = dateRange(startDate, endDate);
  const effectiveGroupBy = groupBy === 'day' || groupBy === 'shift' ? groupBy : (dates.length > 1 ? 'day' : 'shift');

  const [machineRows] = await db.query(
    'SELECT id, name, ideal_cycle_time, assigned_operator, iot_enabled FROM machines WHERE id = ?',
    [machineId]
  );
  const machineName = machineRows.length > 0 ? machineRows[0].name : machineId;
  const machineDefault = machineRows[0] || {};

  // A machine with no ESP32/Raspberry Pi wired up has never produced a real pulse/status_log -
  // there is nothing to query. Short-circuit before touching pulses/status_logs at all, rather
  // than running the whole date-range walk just to land on all-zero rows.
  if (machineRows.length > 0 && !machineRows[0].iot_enabled) {
    return { machineId, machineName, startDate, endDate, groupBy: groupBy || 'day', connected: false, kpis: null, rows: [] };
  }

  const now = Date.now();
  const rangeStart = getShiftWindow(dates[0], 'Shift C').start;
  const rangeEnd = new Date(getShiftWindow(dates[dates.length - 1], 'Shift C').start.getTime() + 24 * 3600000);

  // Bulk-prefetch the whole range once on real MySQL instead of querying per (date x shift) -
  // over a real network connection to the DB host, one round-trip per shift made a 30-day
  // range take minutes. Mock mode has no network latency to amortize, so it keeps the simpler
  // per-shift queries (getShiftMeta / computeWindowMetrics's own fetch-by-window fallback).
  let bulkPulses = null;
  let bulkStatusLogs = null;
  let schedulesByShiftKey = null;
  if (!db.isMock) {
    bulkPulses = await fetchPulsesInRange(machineId, rangeStart, rangeEnd);
    bulkStatusLogs = await fetchStatusLogsOverlapping(machineId, rangeStart, rangeEnd);
    const [scheduleRows] = await db.query(
      'SELECT * FROM part_schedules WHERE machine_id = ? AND plan_date >= ? AND plan_date <= ? ORDER BY sequence ASC',
      [machineId, dates[0], dates[dates.length - 1]]
    );
    schedulesByShiftKey = new Map();
    for (const entry of scheduleRows) {
      const key = `${entry.plan_date}|${entry.shift}`;
      if (!schedulesByShiftKey.has(key)) schedulesByShiftKey.set(key, []);
      schedulesByShiftKey.get(key).push(entry);
    }
  }

  const shiftRows = [];

  for (const dateStr of dates) {
    for (const shiftName of shiftsToWalk) {
      const window = getShiftWindow(dateStr, shiftName);
      if (window.start.getTime() > now) continue; // future shift - nothing has happened yet

      const meta = schedulesByShiftKey
        ? deriveShiftMeta(schedulesByShiftKey.get(`${dateStr}|${shiftName}`) || [], machineDefault)
        : await getShiftMeta(machineId, dateStr, shiftName);

      const metrics = await computeWindowMetrics(machineId, dateStr, window.start, window.end, {
        idealCycleTime: meta.idealCycleTime,
        partScheduleIds: meta.scheduled ? meta.partScheduleIds : null,
        machineIdealCycleTime: machineDefault.ideal_cycle_time,
        statusLogs: bulkStatusLogs,
        pulses: bulkPulses
      });

      // Skip shifts with nothing scheduled and nothing that happened - avoids cluttering the
      // report with rows for shifts the machine simply wasn't running in.
      if (!meta.scheduled && metrics.totalCount === 0 && metrics.totalDowntimeSeconds === 0) continue;

      if (operator && meta.operator !== operator) continue;
      if (partName && meta.partName !== partName) continue;

      const row = {
        date: dateStr,
        shift: shiftName,
        operator: meta.operator,
        partName: meta.partName,
        target: meta.target,
        ...metrics
      };
      if (!includeRaw) {
        delete row.statusLogs;
        delete row.pulses;
      }
      shiftRows.push(row);
    }
  }

  const rows = effectiveGroupBy === 'day' ? collapseByDay(shiftRows) : shiftRows;
  const kpis = summarizeKpis(rows, machineId, machineName, startDate, endDate);

  return { machineId, machineName, startDate, endDate, groupBy: effectiveGroupBy, kpis, rows };
}

/**
 * Groups a flat downtime event list by day/shift/week/month for the Downtime Analysis table.
 */
function groupDowntimeEvents(events, groupBy) {
  const keyFor = (e) => {
    if (groupBy === 'shift') return `${e.date}|${e.shift}`;
    if (groupBy === 'week') return isoWeekKey(e.date);
    if (groupBy === 'month') return e.date.slice(0, 7);
    return e.date;
  };

  const groups = new Map();
  for (const event of events) {
    const key = keyFor(event);
    if (!groups.has(key)) {
      groups.set(key, { key, date: event.date, shift: groupBy === 'shift' ? event.shift : null, totalDowntimeSeconds: 0, events: 0 });
    }
    const g = groups.get(key);
    g.totalDowntimeSeconds += event.durationSeconds;
    g.events += 1;
  }
  return Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Builds the Downtime Analysis module's flat event list, grouped totals, and headline KPIs for
 * a machine over [startDate, endDate]. status_before/status_after are read off the neighboring
 * status_logs rows for the same machine - safe because ensureActiveStatusLog() (mqttService.js)
 * guarantees at most one open log per machine at any time, so Stopped rows are always bounded
 * by a Running/Not Connected row on each side.
 */
/**
 * Planned production seconds for one calendar date - the whole day (minus that day's breaks)
 * when no shift filter is applied, or just that one shift's window (minus its own breaks) when
 * `shift` is given. Used as the Downtime % denominator so filtering by shift doesn't compare a
 * single shift's downtime against a whole day's planned time.
 */
function plannedSecondsForDate(dateStr, shift) {
  const midnight = getShiftWindow(dateStr, 'Shift C').start;
  const breaks = getPlannedBreaks(midnight);

  if (shift) {
    const window = getShiftWindow(dateStr, shift);
    const windowSeconds = (window.end.getTime() - window.start.getTime()) / 1000;
    const breakSeconds = breaks.reduce((s, b) => s + getIntervalOverlapSeconds(window.start, window.end, b.start, b.end), 0);
    return windowSeconds - breakSeconds;
  }

  const breakSeconds = breaks.reduce((s, b) => s + (b.end.getTime() - b.start.getTime()) / 1000, 0);
  return 86400 - breakSeconds;
}

export async function buildDowntimeReport(machineId, startDate, endDate, groupBy = 'day', { shift, operator, partName } = {}) {
  const dates = dateRange(startDate, endDate);
  const rangeStart = getShiftWindow(dates[0], 'Shift C').start;
  const rangeEnd = new Date(getShiftWindow(dates[dates.length - 1], 'Shift C').start.getTime() + 24 * 3600000);

  const [machineRows] = await db.query('SELECT id, name, iot_enabled FROM machines WHERE id = ?', [machineId]);
  const machineName = machineRows.length > 0 ? machineRows[0].name : machineId;

  // No physically-wired device, no real status_logs to query - see buildOeeReportRows above.
  if (machineRows.length > 0 && !machineRows[0].iot_enabled) {
    return { machineId, machineName, startDate, endDate, groupBy, shift: shift || null, operator: operator || null, partName: partName || null, connected: false, kpis: null, groups: [], events: [] };
  }

  const logs = await fetchStatusLogsOverlapping(machineId, rangeStart, rangeEnd);
  const allSorted = [...logs].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  const now = new Date();

  // A shift whose window has FULLY elapsed with zero Running seconds anywhere in it never
  // actually got going - that's a materially different situation from the ordinary short delay
  // between shift start and the first pulse (the ongoing/current shift, still in progress, is
  // deliberately excluded here since it's not yet knowable whether it will start). Any downtime
  // still carrying the default 'Shift Start' reason inside one of these windows is relabeled
  // 'Shift not started' below, instead of silently inflating the 'Shift Start' bucket with hours
  // that were never a startup delay at all.
  const notStartedShiftKeys = new Set();
  dates.forEach((dateStr) => {
    SHIFT_NAMES.forEach((shiftName) => {
      const window = getShiftWindow(dateStr, shiftName);
      if (window.start.getTime() > now.getTime()) return; // future shift - nothing happened yet
      if (window.end.getTime() > now.getTime()) return; // still in progress - not a foregone conclusion
      const midnightForDate = getShiftWindow(dateStr, 'Shift C').start;
      const breaksForDate = getPlannedBreaks(midnightForDate);
      const { runningSeconds } = aggregateStatusLogs(allSorted, window.start, window.end, breaksForDate);
      if (runningSeconds === 0) {
        notStartedShiftKeys.add(`${dateStr}|${shiftName}`);
      }
    });
  });

  // A single continuous "Stopped" status_logs row can predate rangeStart (a stoppage that began
  // days ago and is still open) or run past rangeEnd/"now". Attributing its FULL raw duration to
  // whichever shift its original start_time happened to fall in - as a naive "one log = one
  // event" mapping would - lets an old, still-open stoppage's entire multi-day duration leak into
  // a single shift's report (Downtime % > 100%, an event dated days before the requested range).
  // Instead, split each log into one sub-event per (date, shift) window it actually overlaps
  // within the requested range, clipped to that window's boundaries - duration can then never
  // exceed the shift's own length, and date/shift always reflect real time spent in that window.
  const allEvents = [];
  allSorted
    .filter((log) => log.status === 'Stopped')
    .forEach((log) => {
      const idx = allSorted.findIndex((l) => l.id === log.id);
      const before = idx > 0 ? allSorted[idx - 1].status : null;
      const after = idx >= 0 && idx < allSorted.length - 1 ? allSorted[idx + 1].status : null;
      const reason = log.downtime_reason || 'Other';

      const logStart = new Date(Math.max(new Date(log.start_time).getTime(), rangeStart.getTime()));
      const logEndRaw = log.end_time ? new Date(log.end_time) : new Date();
      const logEnd = new Date(Math.min(logEndRaw.getTime(), rangeEnd.getTime()));
      if (logEnd <= logStart) return;

      dates.forEach((dateStr) => {
        SHIFT_NAMES.forEach((shiftName) => {
          const window = getShiftWindow(dateStr, shiftName);
          const overlapStart = new Date(Math.max(logStart.getTime(), window.start.getTime()));
          const overlapEnd = new Date(Math.min(logEnd.getTime(), window.end.getTime()));
          if (overlapEnd <= overlapStart) return;

          const shiftKey = `${dateStr}|${shiftName}`;
          const effectiveReason = reason === 'Shift Start' && notStartedShiftKeys.has(shiftKey)
            ? 'Shift not started'
            : reason;

          // Exclude planned-break overlap from the counted duration - but ONLY when this event's
          // own reason is something OTHER than the break itself (e.g. 'Shift not started' bleeding
          // through the plant's scheduled Shift C tea breaks, which shouldn't inflate that bucket).
          // This mirrors how computeWindowMetrics/aggregateStatusLogs (oeeCalculator.js) exclude
          // scheduled-break time from Planned Production Time/Operating Time for generic downtime.
          // When the reason IS 'Tea Break'/'Lunch Break'/etc, the operator's actual stoppage rarely
          // lines up exactly with the plant's fixed schedule (left 2 min early, back 4 min late) -
          // subtracting the scheduled window's overlap from it would wrongly shave a real ~36-minute
          // lunch stoppage down to ~7 minutes just because most of it coincided with the schedule.
          // The full observed duration belongs entirely to that break reason.
          let durationSeconds = (overlapEnd.getTime() - overlapStart.getTime()) / 1000;
          if (!PLANNED_REASONS.has(effectiveReason)) {
            const midnightForDate = getShiftWindow(dateStr, 'Shift C').start;
            const breaksForDate = getPlannedBreaks(midnightForDate);
            const breakOverlapSeconds = breaksForDate.reduce(
              (s, b) => s + getIntervalOverlapSeconds(overlapStart, overlapEnd, b.start, b.end),
              0
            );
            durationSeconds = Math.max(0, durationSeconds - breakOverlapSeconds);
          }
          if (durationSeconds <= 0) return;

          allEvents.push({
            id: `${log.id}-${dateStr}-${shiftName}`,
            date: dateStr,
            shift: shiftName,
            startTime: overlapStart,
            endTime: overlapEnd.getTime() === logEndRaw.getTime() ? log.end_time : overlapEnd,
            durationSeconds,
            reason: effectiveReason,
            category: PLANNED_REASONS.has(effectiveReason) ? 'Planned' : 'Unplanned',
            operator: log.operator_id,
            partNumber: log.part_name,
            statusBefore: before,
            statusAfter: after,
            remarks: null
          });
        });
      });
    });

  // Applied AFTER the before/after neighbor lookup above (which needs the full, unfiltered
  // sequence of logs to correctly identify what status the machine was in immediately before/
  // after each downtime event) - filtering the raw logs first would corrupt that neighbor lookup.
  const events = allEvents.filter((e) => {
    if (shift && e.shift !== shift) return false;
    if (operator && e.operator !== operator) return false;
    if (partName && e.partNumber !== partName) return false;
    return true;
  });

  const groups = groupDowntimeEvents(events, groupBy);

  const totalDowntimeSeconds = events.reduce((s, e) => s + e.durationSeconds, 0);
  const plannedDowntimeSeconds = events.filter((e) => e.category === 'Planned').reduce((s, e) => s + e.durationSeconds, 0);
  const unplannedDowntimeSeconds = totalDowntimeSeconds - plannedDowntimeSeconds;

  const totalPlannedProductionSeconds = dates.reduce((sum, dateStr) => sum + plannedSecondsForDate(dateStr, shift), 0);

  const kpis = {
    totalDowntimeSeconds,
    plannedDowntimeSeconds,
    unplannedDowntimeSeconds,
    downtimePercent: totalPlannedProductionSeconds > 0 ? round1((totalDowntimeSeconds / totalPlannedProductionSeconds) * 100) : 0,
    totalEvents: events.length,
    avgDowntimeSeconds: events.length > 0 ? Math.round(totalDowntimeSeconds / events.length) : 0,
    longestDowntimeSeconds: events.length > 0 ? Math.max(...events.map((e) => e.durationSeconds)) : 0
  };

  return { machineId, machineName, startDate, endDate, groupBy, shift: shift || null, operator: operator || null, partName: partName || null, kpis, groups, events };
}

/**
 * Slices one (machine, date, shift) into 1-hour buckets (relative to the shift's own start, not
 * clock-aligned - Shift B starts at 15:30, so its buckets are [15:30-16:30), [16:30-17:30), ...)
 * for the Analytics module's "Hourly Production & OEE Trend" chart:
 *
 *   - target, actual: CUMULATIVE through the end of that hour (matches the spec's "Target Count
 *     (Cumulative)" / "Actual Count (Cumulative)" line-chart series).
 *   - loss: cumulative target minus cumulative actual, floored at 0.
 *   - downtimeSeconds, availability, performance, quality, oee: PER-HOUR (not cumulative) - a
 *     cumulative OEE wouldn't behave meaningfully hour to hour, so these are that hour's own
 *     snapshot, same as every other OEE calculation in this codebase.
 *
 * The cumulative target's rate is derived per scheduled part_schedules entry from
 * calculateAutoTarget's own availableSeconds/target (the same numbers already shown elsewhere for
 * that entry) - target_rate = entry.target / entry.availableSeconds (parts per available second),
 * apportioned by however much of THIS entry's non-break time falls inside each hour bucket. An
 * hour spanning a part changeover correctly sums contributions from both entries.
 */
export async function buildHourlyBreakdown(machineId, dateStr, shiftName) {
  const window = getShiftWindow(dateStr, shiftName);
  const now = new Date();
  const effectiveEnd = window.end.getTime() > now.getTime() ? now : window.end;

  const [machineRows] = await db.query('SELECT ideal_cycle_time, iot_enabled FROM machines WHERE id = ?', [machineId]);
  if (machineRows.length > 0 && !machineRows[0].iot_enabled) {
    return { machineId, date: dateStr, shift: shiftName, connected: false, hours: [] };
  }
  const machineDefaultIdealCycleTime = machineRows[0]?.ideal_cycle_time || 15;

  if (effectiveEnd <= window.start) {
    return { machineId, date: dateStr, shift: shiftName, connected: true, hours: [] };
  }

  const [entries] = await db.query(
    'SELECT * FROM part_schedules WHERE machine_id = ? AND plan_date = ? AND shift = ? ORDER BY sequence ASC',
    [machineId, dateStr, shiftName]
  );

  const entryInfos = entries.map((e) => {
    const entryStart = buildPlantDateTime(dateStr, e.planned_start);
    let entryEnd = buildPlantDateTime(dateStr, e.planned_end);
    if (entryEnd.getTime() <= entryStart.getTime()) entryEnd = new Date(entryEnd.getTime() + 24 * 3600000);
    const { availableSeconds } = calculateAutoTarget({
      planDate: dateStr,
      plannedStart: e.planned_start,
      plannedEnd: e.planned_end,
      idealCycleTime: e.ideal_cycle_time,
      loadUnloadAllowanceSeconds: e.load_unload_allowance_seconds ?? 15
    });
    return {
      entryStart, entryEnd, idealCycleTime: e.ideal_cycle_time,
      rate: availableSeconds > 0 ? e.target / availableSeconds : 0
    };
  });

  const midnight = getShiftWindow(dateStr, 'Shift C').start;
  const breaks = getPlannedBreaks(midnight);

  const pulses = await fetchPulsesInRange(machineId, window.start, effectiveEnd);
  const statusLogs = await fetchStatusLogsOverlapping(machineId, window.start, effectiveEnd);

  const hours = [];
  let cursor = new Date(window.start);
  let cumulativeTarget = 0;
  let cumulativeActual = 0;
  let hourIndex = 0;

  while (cursor.getTime() < effectiveEnd.getTime()) {
    const hourEnd = new Date(Math.min(cursor.getTime() + 3600000, effectiveEnd.getTime()));
    hourIndex += 1;

    let targetIncrement = 0;
    let idealCycleTimeForHour = machineDefaultIdealCycleTime;
    entryInfos.forEach((info) => {
      const overlapStart = new Date(Math.max(cursor.getTime(), info.entryStart.getTime()));
      const overlapEnd = new Date(Math.min(hourEnd.getTime(), info.entryEnd.getTime()));
      if (overlapEnd <= overlapStart) return;
      const breakSecondsInOverlap = breaks.reduce((s, b) => s + getIntervalOverlapSeconds(overlapStart, overlapEnd, b.start, b.end), 0);
      const availableInOverlap = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 1000 - breakSecondsInOverlap);
      targetIncrement += availableInOverlap * info.rate;
      idealCycleTimeForHour = info.idealCycleTime;
    });
    cumulativeTarget += targetIncrement;

    const hourPulses = pulses.filter((p) => {
      const t = new Date(p.timestamp).getTime();
      return t >= cursor.getTime() && t < hourEnd.getTime();
    });
    cumulativeActual += hourPulses.length;

    const { runningSeconds } = aggregateStatusLogs(statusLogs, cursor, hourEnd, breaks);
    const totalWindowSeconds = (hourEnd.getTime() - cursor.getTime()) / 1000;
    const hourBreakSeconds = breaks.reduce((s, b) => s + getIntervalOverlapSeconds(cursor, hourEnd, b.start, b.end), 0);
    const plannedSeconds = Math.max(1, totalWindowSeconds - hourBreakSeconds);
    const operatingSeconds = Math.min(runningSeconds, plannedSeconds);
    const downtimeSeconds = Math.max(0, plannedSeconds - operatingSeconds);
    const goodCount = hourPulses.filter((p) => p.is_good === 1 || p.is_good === true).length;

    const { availability, performance, quality, oee } = computeOeeFromTotals({
      plannedSeconds, operatingSeconds, totalCount: hourPulses.length, goodCount, idealCycleTime: idealCycleTimeForHour
    });

    const roundedTarget = Math.round(cumulativeTarget);
    hours.push({
      hour: hourIndex,
      label: `Hour ${hourIndex}`,
      timeRange: `${formatPlantTime(cursor)}–${formatPlantTime(hourEnd)}`,
      target: roundedTarget,
      actual: cumulativeActual,
      loss: Math.max(0, roundedTarget - cumulativeActual),
      achievementPercent: roundedTarget > 0 ? round1((cumulativeActual / roundedTarget) * 100) : null,
      downtimeSeconds: Math.round(downtimeSeconds),
      availability: round1(availability),
      performance: round1(performance),
      quality: round1(quality),
      oee: round1(oee)
    });

    cursor = hourEnd;
  }

  return { machineId, date: dateStr, shift: shiftName, connected: true, hours };
}
