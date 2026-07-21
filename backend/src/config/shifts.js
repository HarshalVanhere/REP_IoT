// Single source of truth for shift boundaries. Previously this same 07:00/15:30/24:00
// split was hand-duplicated in oeeCalculator.js and the frontend's App.jsx.
export const SHIFT_DEFINITIONS = [
  { name: 'Shift A', startMinutes: 7 * 60, endMinutes: 15.5 * 60, label: '07:00 AM - 03:30 PM' },
  { name: 'Shift B', startMinutes: 15.5 * 60, endMinutes: 24 * 60, label: '03:30 PM - 12:00 AM' },
  { name: 'Shift C', startMinutes: 0, endMinutes: 7 * 60, label: '12:00 AM - 07:00 AM' }
];

export const SHIFT_NAMES = SHIFT_DEFINITIONS.map((s) => s.name);

// The 07:00/15:30/24:00 boundaries above are the PLANT's wall-clock times, not the server
// process's. Cloud hosts and a Raspberry Pi gateway commonly run their OS clock in UTC
// regardless of where the plant physically is - if shift math used the server process's local
// timezone (via Date.prototype.getHours() etc.), a Pi/cloud host set to UTC would compute
// shift boundaries offset by however many hours UTC differs from the plant's real timezone,
// silently making "Shift A" mean something different than what a PPC Engineer typed into the
// Planning Board expecting plant-local hours. Pinning an explicit IANA timezone here makes
// shift/date calculation identical everywhere this code runs, independent of server OS config.
// Override via PLANT_TIMEZONE in .env if this deployment is not in India.
const PLANT_TIMEZONE = process.env.PLANT_TIMEZONE || 'Asia/Kolkata';

const wallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
});

/**
 * Breaks a Date down into its wall-clock components AS OBSERVED IN THE PLANT'S TIMEZONE,
 * regardless of what timezone the server process itself is running under.
 */
function plantWallClock(date) {
  const parts = wallClockFormatter.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  // Intl's 24-hour format reports midnight as "24" rather than "00" in some engines/locales -
  // normalize it so minute-of-day math below doesn't silently wrap to 1440.
  const hour = get('hour') === '24' ? 0 : parseInt(get('hour'), 10);
  return {
    year: parseInt(get('year'), 10),
    month: parseInt(get('month'), 10),
    day: parseInt(get('day'), 10),
    hour,
    minute: parseInt(get('minute'), 10)
  };
}

/**
 * Returns the shift name ('Shift A'|'Shift B'|'Shift C') active at the given Date/timestamp,
 * evaluated in the plant's timezone.
 */
export function getShiftForTimestamp(date) {
  const d = date ? new Date(date) : new Date();
  const { hour, minute } = plantWallClock(d);
  const minutes = hour * 60 + minute;
  const shift = SHIFT_DEFINITIONS.find((s) => minutes >= s.startMinutes && minutes < s.endMinutes);
  return (shift || SHIFT_DEFINITIONS[2]).name;
}

/**
 * Returns today's date as a YYYY-MM-DD string in the plant's timezone (matches how
 * <input type="date"> and MySQL DATE columns both represent dates).
 */
export function toDateOnlyString(date = new Date()) {
  const { year, month, day } = plantWallClock(new Date(date));
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const offsetFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TIMEZONE,
  timeZoneName: 'shortOffset'
});

/**
 * The plant timezone's UTC offset (in minutes) on a given calendar date. Computed per-date
 * rather than as a constant so this stays correct if PLANT_TIMEZONE is ever changed to a
 * DST-observing zone (Asia/Kolkata itself has no DST).
 */
function getPlantUtcOffsetMinutes(year, month, day) {
  const offsetPart = offsetFormatter.formatToParts(new Date(Date.UTC(year, month - 1, day, 12)))
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT+5:30"
  const offsetMatch = offsetPart.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  return offsetMatch
    ? (offsetMatch[1] === '-' ? -1 : 1) * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3] || '0', 10))
    : 0;
}

/**
 * Builds the real Date/instant corresponding to a wall-clock 'YYYY-MM-DD' + 'HH:MM(:SS)' pair
 * AS OBSERVED IN THE PLANT'S TIMEZONE - the timezone-safe equivalent of
 * `new Date(year, month-1, day, hh, mm, ss)`, which instead assumes the SERVER PROCESS's own
 * OS timezone. Used anywhere a part_schedules planned_start/planned_end needs to be compared
 * against the current instant (e.g. the watchdog's auto-advance check).
 */
export function buildPlantDateTime(dateStr, timeStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  const offsetMinutes = getPlantUtcOffsetMinutes(year, month, day);
  const dayStartUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60000;
  return new Date(dayStartUtc + (hh * 60 + mm) * 60000 + (ss || 0) * 1000);
}

/**
 * Returns the { start, end } Date objects (real instants in time) for a given shift on a
 * given calendar date (dateStr as 'YYYY-MM-DD'), as observed in the plant's timezone.
 * Shift C's window is 00:00-07:00 of that same calendar date.
 */
export function getShiftWindow(dateStr, shiftName) {
  const definition = SHIFT_DEFINITIONS.find((s) => s.name === shiftName);
  if (!definition) {
    throw new Error(`Unknown shift: ${shiftName}`);
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const offsetMinutes = getPlantUtcOffsetMinutes(year, month, day);
  const dayStartUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMinutes * 60000;

  const start = new Date(dayStartUtc + definition.startMinutes * 60000);
  const end = new Date(dayStartUtc + definition.endMinutes * 60000);
  return { start, end };
}
