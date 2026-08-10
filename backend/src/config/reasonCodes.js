// Single source of truth for downtime reason codes. The English strings below are the
// canonical VALUES - what actually gets stored in status_logs.downtime_reason and what OEE
// aggregation (oeeCalculator.js) and every Cloud dashboard/report/export key off of. They must
// stay in English regardless of what language the operator terminal displays, since the DB and
// the Cloud side are shared by both languages.
// Consumed by oeeCalculator.js (aggregation), api.js (GET /api/reason-codes), and fetched once
// by the frontend instead of being hardcoded in multiple components.
export const PREDEFINED_REASONS = [
  'Shift Start',
  'Operator Break',
  'Tea Break',
  'Lunch Break',
  'Tool Wear / Replacement',
  'Material Shortage',
  'No Power',
  'Machine Breakdown',
  'Measure and Adjustment',
  'Machine Setup Change',
  'Defect / Rework',
  'Line Organisation (1S-2S)',
  'Setup / Calibration',
  'No Plan',
  'NPD Trial',
  'Preventive Maintenance (PM)',
  'Unplanned Meeting'
];

// Reasons treated as "Planned" downtime everywhere duration/category is computed (the
// Downtime Analysis module's Planned/Unplanned split in reportingService.js, and the
// Stopped-time/reasons aggregation in oeeCalculator.js's aggregateStatusLogs). Single shared
// definition so the two can never drift apart the way they previously did (this Set used to be
// duplicated in reportingService.js with a stale 'Preventive Maintenance' string that didn't
// match the canonical 'Preventive Maintenance (PM)' value above, silently never matching).
export const PLANNED_REASONS = new Set([
  'Tea Break',
  'Lunch Break',
  'Preventive Maintenance (PM)'
]);

// Marathi display labels for the Operator Terminal ONLY (frontend/src/components/
// OperatorTerminal.jsx via DowntimeReasonModal.jsx) - keyed by the English canonical value
// above. The Cloud dashboard, reports, and exports always render the English value directly and
// never consult this map. Adding a reason above without a matching entry here just falls back to
// showing the English text on the operator screen too (see api.js's /reason-codes route).
export const REASON_LABELS_MR = {
  'Shift Start': 'शिफ्ट सुरू',
  'Operator Break': 'ऑपरेटर ब्रेक (पाणी, स्वच्छतागृह इ.)',
  'Tea Break': 'चहा ब्रेक',
  'Lunch Break': 'जेवणाची सुट्टी',
  'Tool Wear / Replacement': 'टूल झीज / टूल बदल / इन्सर्ट बदल',
  'Material Shortage': 'मटेरियल उपलब्ध नाही',
  'No Power': 'वीज उपलब्ध नाही',
  'Machine Breakdown': 'मशीन बिघाड',
  'Measure and Adjustment': 'मोजमाप व अॅडजस्टमेंट',
  'Machine Setup Change': 'मशीन सेटअप बदल',
  'Defect / Rework': 'दोष / रीवर्क',
  'Line Organisation (1S-2S)': 'लाइन व्यवस्था (1S-2S)',
  'Setup / Calibration': 'सेटअप / कॅलिब्रेशन',
  'No Plan': 'No Plan',
  'NPD Trial': 'नवीन उत्पादन चाचणी (NPD)',
  'Preventive Maintenance (PM)': 'प्रतिबंधात्मक देखभाल (PM)',
  'Unplanned Meeting': 'अनियोजित बैठक'
};
