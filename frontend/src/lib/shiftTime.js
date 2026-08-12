// Frontend mirror of backend/src/config/shifts.js's shift boundaries and PLANT_TIMEZONE - used
// ONLY to decide which shift/calendar-day a timestamp displays under (Overview page filtering,
// Reports Log grouping). It intentionally contains no downtime/OEE math: every actual total shown
// anywhere in the app comes from the backend's buildDowntimeReport()/buildOeeReportRows()/
// buildPlantSummary(), never re-derived here. Without this, `new Date(ts).getHours()` reads the
// BROWSER's own local timezone, which silently buckets events into the wrong shift/day whenever
// a viewer isn't set to the plant's zone - this file makes that bucketing timezone-safe the same
// way the backend already is.
const PLANT_TIMEZONE = 'Asia/Kolkata';

const wallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIMEZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

// en-CA formats as YYYY-MM-DD, matching MySQL DATE columns and <input type="date">.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function getShiftForTimestamp(timestamp) {
  if (!timestamp) return 'Shift A';
  const parts = wallClockFormatter.formatToParts(new Date(timestamp));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10);
  const minute = parseInt(get('minute'), 10);
  const minutes = hour * 60 + minute;
  if (minutes >= 7 * 60 && minutes < 15.5 * 60) return 'Shift A';
  if (minutes >= 15.5 * 60 && minutes < 24 * 60) return 'Shift B';
  return 'Shift C';
}

export function toPlantDateString(timestamp) {
  return dateFormatter.format(timestamp ? new Date(timestamp) : new Date());
}
