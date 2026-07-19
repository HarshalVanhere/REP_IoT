// Single source of truth for downtime reason codes.
// Consumed by oeeCalculator.js (aggregation), api.js (GET /api/reason-codes),
// and fetched once by the frontend instead of being hardcoded in multiple components.
export const PREDEFINED_REASONS = [
  'Tea Break',
  'Lunch Break',
  'Tool Wear / Replacement',
  'Measure and Adjustment',
  'No Power',
  'Material Shortage',
  'Mechanical Jam / Fault',
  'Machine Breakdown',
  'Startup',
  'Speed Loss',
  'Defect / Rework',
  'Line Organisation',
  'Setup / Calibration',
  'No Plan',
  'NPD Trails',
  'Preventive Maintenance',
  'Operator Break',
  'Unplanned Meeting',
  'Other'
];
