// Run with: node tests/smoke/announcement_flow.js  (kein MySQL nötig)
const assert = require('node:assert/strict');
const { _internal } = require('../../src/interactions/announcement');
const { COLORS, buildAnnouncementModal } = require('../../src/commands/announcement');

assert.ok(_internal, 'announcement interactions export _internal');
const { previewSessions, buildAnnouncementEmbed, PREVIEW_TTL_MS, sweepSessions, truncateForDiff } = _internal;

console.log('Running Test 1: Embed-Builder (create)...');
const e1 = buildAnnouncementEmbed({ title: 'T', description: 'D', color: COLORS.gruen, imageUrl: 'https://example.com/i.png' });
assert.equal(e1.data.title, 'T');
assert.equal(e1.data.color, COLORS.gruen);
assert.equal(e1.data.footer.text, '🐾 Oreo');
assert.equal(e1.data.image.url, 'https://example.com/i.png');
console.log('   Test 1 passed');

console.log('Running Test 2: Embed-Builder (edited: Footer-Marker + Original-Timestamp)...');
const orig = new Date('2026-01-01T12:00:00Z');
const e2 = buildAnnouncementEmbed({ title: 'T', description: 'D', color: COLORS.blurple, imageUrl: null, createdAt: orig, edited: true });
assert.equal(e2.data.footer.text, '🐾 Oreo • bearbeitet');
assert.equal(new Date(e2.data.timestamp).getTime(), orig.getTime());
assert.equal(e2.data.image, undefined, 'no image field when imageUrl null');
console.log('   Test 2 passed');

console.log('Running Test 3: Session-TTL-Sweeper...');
previewSessions.clear();
previewSessions.set('fresh', { expiresAt: Date.now() + PREVIEW_TTL_MS });
previewSessions.set('stale', { expiresAt: Date.now() - 1 });
sweepSessions();
assert.ok(previewSessions.has('fresh') && !previewSessions.has('stale'), 'sweeper removes only expired');
previewSessions.clear();
console.log('   Test 3 passed');

console.log('Running Test 4: Modal-Vorbefüllung...');
const m = buildAnnouncementModal({ customId: 'announcement:modal:edit:5', title: 'Alt', description: 'AltD', imageUrl: 'https://x.de/a.png' });
const rows = m.toJSON().components;
assert.equal(m.toJSON().custom_id, 'announcement:modal:edit:5');
assert.equal(rows[0].components[0].value, 'Alt');
assert.equal(rows[2].components[0].value, 'https://x.de/a.png');
console.log('   Test 4 passed');

console.log('Running Test 5: truncateForDiff (301-Zeichen-Grenzfall)...');
const longStr = 'x'.repeat(301);
const truncated = truncateForDiff(longStr);
assert.equal(truncated, `${'x'.repeat(300)}…`);
assert.equal(truncated.length, 301);
console.log('   Test 5 passed');

console.log('OK — announcement flow smoke test passed');
