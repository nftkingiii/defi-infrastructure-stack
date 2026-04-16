/**
 * publisher/logger.js
 */
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;

function format(level, msg, ...args) {
  let out = msg;
  for (const arg of args) out = out.replace(/%[sdif%]/, a => a === '%%' ? '%' : String(arg));
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return `${ts} | ${level.toUpperCase().padEnd(5)} | ${out}`;
}

module.exports = {
  debug: (m, ...a) => { if (LOG_LEVEL <= 0) console.debug(format('debug', m, ...a)); },
  info:  (m, ...a) => { if (LOG_LEVEL <= 1) console.log(format('info',  m, ...a)); },
  warn:  (m, ...a) => { if (LOG_LEVEL <= 2) console.warn(format('warn',  m, ...a)); },
  error: (m, ...a) => { if (LOG_LEVEL <= 3) console.error(format('error', m, ...a)); },
};
