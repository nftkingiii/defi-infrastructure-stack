/**
 * indexer/logger.js
 * Simple structured logger. No dependencies.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function format(level, msg, ...args) {
  let out = msg;
  for (const arg of args) {
    out = out.replace(/%[sdifdo]/, String(arg));
  }
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `${ts} | ${level.toUpperCase().padEnd(5)} | ${out}`;
}

const logger = {
  debug: (msg, ...args) => {
    if (LOG_LEVEL <= LEVELS.debug) console.debug(format('debug', msg, ...args));
  },
  info: (msg, ...args) => {
    if (LOG_LEVEL <= LEVELS.info) console.log(format('info', msg, ...args));
  },
  warn: (msg, ...args) => {
    if (LOG_LEVEL <= LEVELS.warn) console.warn(format('warn', msg, ...args));
  },
  error: (msg, ...args) => {
    if (LOG_LEVEL <= LEVELS.error) console.error(format('error', msg, ...args));
  },
};

module.exports = logger;
