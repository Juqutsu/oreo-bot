// Run with: node tests/smoke/captcha_answers.js
const assert = require('node:assert/strict');
const { _internal } = require('../../src/interactions/captcha');

assert.ok(_internal, 'captcha module must export _internal for tests');
const { generatePuzzle, pendingPuzzles } = _internal;

const payload = generatePuzzle('guild1', 'user1', 1);
const row = payload.components[0];
for (const button of row.components) {
  const id = button.data.custom_id;
  assert.ok(!id.includes('correct'), `customId leaks answer: ${id}`);
  assert.ok(!id.includes('wrong'), `customId leaks answer: ${id}`);
  assert.match(id, /^captcha_pick_user1_\d$/, `unexpected customId format: ${id}`);
}

const entry = pendingPuzzles.get('guild1:user1');
assert.ok(entry, 'pending puzzle stored server-side');
assert.equal(entry.attempt, 1);
assert.ok(entry.options.includes(entry.correctEmoji), 'correct emoji among options');
assert.ok(entry.expiresAt > Date.now(), 'entry has TTL');

// Attempt count survives a re-generated puzzle (anti reset-exploit)
generatePuzzle('guild1', 'user1', 3);
assert.equal(pendingPuzzles.get('guild1:user1').attempt, 3);

pendingPuzzles.clear();
console.log('OK — captcha answers are server-side');
