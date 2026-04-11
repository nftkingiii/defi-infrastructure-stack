/**
 * deploy/state.js
 * Persists deployed contract addresses to deployments/{network}.json.
 * Lets you re-run partial deployments without redeploying already-deployed contracts.
 */

const fs   = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'deployments');

function _filePath(network) {
  return path.join(DIR, `${network}.json`);
}

function load(network) {
  const file = _filePath(network);
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function save(network, state) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(_filePath(network), JSON.stringify(state, null, 2));
}

function set(network, key, value) {
  const state = load(network);
  state[key]  = value;
  save(network, state);
}

function get(network, key) {
  return load(network)[key];
}

function summarise(network) {
  const state = load(network);
  if (!Object.keys(state).length) return '  (no deployments recorded)';
  return Object.entries(state)
    .map(([k, v]) => `  ${k.padEnd(28)} ${v}`)
    .join('\n');
}

module.exports = { load, save, set, get, summarise };
