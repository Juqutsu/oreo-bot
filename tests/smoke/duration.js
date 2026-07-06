// Run with: node tests/smoke/duration.js
const { parseDuration, formatDuration, MAX_TIMEOUT_MS } = require('../../src/duration');
const assert = require('node:assert/strict');

assert.equal(parseDuration('30s'), 30_000, '30s → 30000 ms');
assert.equal(parseDuration('10m'), 10 * 60_000, '10m → 600000 ms');
assert.equal(parseDuration('2h'), 2 * 60 * 60_000, '2h → 7200000 ms');
assert.equal(parseDuration('1t'), 24 * 60 * 60_000, '1t → 86400000 ms (German Tag)');
assert.equal(parseDuration('1w'), 7 * 24 * 60 * 60_000, '1w → 604800000 ms');
assert.equal(parseDuration('garbage'), null, 'garbage → null');
assert.equal(parseDuration(''), null, 'empty → null');
assert.equal(MAX_TIMEOUT_MS, 28 * 24 * 60 * 60 * 1000, 'MAX_TIMEOUT_MS = 28 days');
assert.equal(formatDuration(60_000), '1 Minute', 'formatDuration(60_000) → "1 Minute"');
assert.equal(formatDuration(120_000), '2 Minuten', 'formatDuration(120_000) → "2 Minuten" (plural)');
const { MAX_TEMP_MS } = require('../../src/duration');
assert.equal(parseDuration('7d'), 7 * 86_400_000, '7d → 7 days (d alias for Tag)');
assert.equal(parseDuration('1D'), 86_400_000, '1D → case-insensitive');
assert.equal(MAX_TEMP_MS, 365 * 86_400_000, 'MAX_TEMP_MS = 365 days');
assert.ok(parseDuration('999999999w') > MAX_TEMP_MS, 'huge duration parses but exceeds cap');
console.log('OK — duration smoke test passed');
