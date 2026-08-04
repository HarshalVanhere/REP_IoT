// Single source of truth for downtime reason codes.
// Consumed by oeeCalculator.js (aggregation), api.js (GET /api/reason-codes),
// and fetched once by the frontend instead of being hardcoded in multiple components.
export const PREDEFINED_REASONS = [
  'शिफ्ट सुरू',
  'ऑपरेटर ब्रेक (पाणी, स्वच्छतागृह इ.)',
  'चहा ब्रेक',
  'जेवणाची सुट्टी',
  'टूल झीज / टूल बदल / इन्सर्ट बदल',
  'मटेरियल उपलब्ध नाही',
  'वीज उपलब्ध नाही',
  'मशीन बिघाड',
  'मोजमाप व अॅडजस्टमेंट',
  'मशीन सेटअप बदल',
  'दोष / रीवर्क',
  'लाइन व्यवस्था (1S-2S)',
  'सेटअप / कॅलिब्रेशन',
  'No Plan',
  'नवीन उत्पादन चाचणी (NPD)',
  'प्रतिबंधात्मक देखभाल (PM)',
  'अनियोजित बैठक'
];
