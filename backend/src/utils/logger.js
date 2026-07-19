// Lightweight leveled/timestamped logger. Deliberately dependency-free since this
// process runs unattended on a Raspberry Pi edge gateway as well as in the cloud.
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function timestamp() {
  return new Date().toISOString();
}

function log(level, icon, args) {
  if (LEVELS[level] > activeLevel) return;
  const prefix = `[${timestamp()}] ${icon}`;
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  writer(prefix, ...args);
}

export const logger = {
  error: (...args) => log('error', '❌', args),
  warn: (...args) => log('warn', '⚠️ ', args),
  info: (...args) => log('info', 'ℹ️ ', args),
  debug: (...args) => log('debug', '🐛', args)
};

export default logger;
