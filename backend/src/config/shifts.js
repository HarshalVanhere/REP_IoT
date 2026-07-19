// Single source of truth for shift boundaries. Previously this same 07:00/15:30/24:00
// split was hand-duplicated in oeeCalculator.js and the frontend's App.jsx.
export const SHIFT_DEFINITIONS = [
  { name: 'Shift A', startMinutes: 7 * 60, endMinutes: 15.5 * 60, label: '07:00 AM - 03:30 PM' },
  { name: 'Shift B', startMinutes: 15.5 * 60, endMinutes: 24 * 60, label: '03:30 PM - 12:00 AM' },
  { name: 'Shift C', startMinutes: 0, endMinutes: 7 * 60, label: '12:00 AM - 07:00 AM' }
];

export const SHIFT_NAMES = SHIFT_DEFINITIONS.map((s) => s.name);

/**
 * Returns the shift name ('Shift A'|'Shift B'|'Shift C') active at the given Date/timestamp.
 */
export function getShiftForTimestamp(date) {
  const d = date ? new Date(date) : new Date();
  const minutes = d.getHours() * 60 + d.getMinutes();
  const shift = SHIFT_DEFINITIONS.find((s) => minutes >= s.startMinutes && minutes < s.endMinutes);
  return (shift || SHIFT_DEFINITIONS[2]).name;
}

/**
 * Returns today's date as a YYYY-MM-DD string in local time (matches how <input type="date">
 * and MySQL DATE columns both represent dates, avoiding UTC-shift-by-a-day bugs).
 */
export function toDateOnlyString(date = new Date()) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns the { start, end } Date objects for a given shift on a given calendar date
 * (dateStr as 'YYYY-MM-DD'). Shift C's window is 00:00-07:00 of that same calendar date.
 */
export function getShiftWindow(dateStr, shiftName) {
  const definition = SHIFT_DEFINITIONS.find((s) => s.name === shiftName);
  if (!definition) {
    throw new Error(`Unknown shift: ${shiftName}`);
  }

  const [year, month, day] = dateStr.split('-').map(Number);
  const dayStart = new Date(year, month - 1, day, 0, 0, 0, 0);

  const start = new Date(dayStart.getTime() + definition.startMinutes * 60000);
  const end = new Date(dayStart.getTime() + definition.endMinutes * 60000);
  return { start, end };
}
