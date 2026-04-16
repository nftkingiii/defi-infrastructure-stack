/**
 * deploy/logger.js
 * Minimal deploy logger with timestamps and step tracking.
 */

let _step = 0;

function step(msg, ...args) {
  _step++;
  let out = msg;
  for (const arg of args) out = out.replace(/%[sd]/, String(arg));
  console.log(`\n[${_step}] ${out}`);
}

function info(msg, ...args) {
  let out = msg;
  for (const arg of args) out = out.replace(/%[sd]/, String(arg));
  console.log(`    ${out}`);
}

function success(msg, ...args) {
  let out = msg;
  for (const arg of args) out = out.replace(/%[sd]/, String(arg));
  console.log(`    ✓ ${out}`);
}

function warn(msg, ...args) {
  let out = msg;
  for (const arg of args) out = out.replace(/%[sd]/, String(arg));
  console.warn(`    ⚠ ${out}`);
}

function error(msg, ...args) {
  let out = msg;
  for (const arg of args) out = out.replace(/%[sd]/, String(arg));
  console.error(`    ✗ ${out}`);
}

function divider() {
  console.log('\n' + '─'.repeat(60));
}

module.exports = { step, info, success, warn, error, divider };
