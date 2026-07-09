const assert = require('node:assert');
const handler = require('../../src/events/guildMemberUpdate');
const { decideVerification } = handler._internal;

// verified role newly added -> verify + remove the unverified role the member has
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['U'], newRoleIds: ['U', 'V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: false,
  });
  assert.strictEqual(r.verify, true, 'verified newly added -> verify');
  assert.deepStrictEqual(r.removeUnverified, ['U'], 'removes unverified role member has');
}

// no verified role in new set -> no action
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['U'], newRoleIds: ['U'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'no verified role -> no action');
  assert.deepStrictEqual(r.removeUnverified, [], 'no roles to remove');
}

// bot -> no action even with a verified role present
{
  const r = decideVerification({
    isBot: true, oldRoleIds: [], newRoleIds: ['V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: [], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'bot -> no action');
}

// already had a verified role before -> no action (nothing new)
{
  const r = decideVerification({
    isBot: false, oldRoleIds: ['V'], newRoleIds: ['V', 'X'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: [], oldPartial: false,
  });
  assert.strictEqual(r.verify, false, 'already verified -> no action');
}

// oldMember partial (uncached) + verified now present -> reconcile (idempotent)
{
  const r = decideVerification({
    isBot: false, oldRoleIds: [], newRoleIds: ['V', 'U'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U'], oldPartial: true,
  });
  assert.strictEqual(r.verify, true, 'partial old -> reconcile');
  assert.deepStrictEqual(r.removeUnverified, ['U'], 'partial old removes unverified');
}

// removeUnverified only contains unverified roles the member actually has
{
  const r = decideVerification({
    isBot: false, oldRoleIds: [], newRoleIds: ['V'],
    verifiedRoleIds: ['V'], unverifiedRoleIds: ['U1', 'U2'], oldPartial: false,
  });
  assert.strictEqual(r.verify, true, 'verify true');
  assert.deepStrictEqual(r.removeUnverified, [], 'no unverified roles present -> none removed');
}

console.log('manual_verify smoke OK');
