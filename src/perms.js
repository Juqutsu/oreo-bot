const { MessageFlags } = require('discord.js');
const { getPool } = require('./db');

const TIERS = {
  supporter: 1,
  moderator: 2,
  owner: 3,
};

/**
 * Liefert den höchsten Tier, den ein Member über seine Rollen hat.
 * Server-Owner hat KEINEN Sonderstatus (Single Source of Truth = role_permissions).
 * @param {string} guildId
 * @param {import('discord.js').GuildMember|null} member
 * @returns {Promise<'supporter'|'moderator'|'owner'|null>}
 */
async function getEffectiveTier(guildId, member) {
  if (!member) return null;

  const [rows] = await getPool().execute(
    'SELECT role_id, permission FROM role_permissions WHERE guild_id = ?',
    [guildId],
  );
  const tierByRole = new Map(rows.map((r) => [String(r.role_id), r.permission]));

  let highest = 0;
  let tierName = null;
  for (const roleId of member.roles.cache.keys()) {
    const tier = tierByRole.get(roleId);
    if (!tier) continue;
    if (TIERS[tier] > highest) {
      highest = TIERS[tier];
      tierName = tier;
    }
  }
  return tierName;
}

/**
 * Prüft ob Member mindestens den geforderten Tier hat.
 * @returns {Promise<boolean>}
 */
async function hasTier(guildId, member, requiredTier) {
  const effective = await getEffectiveTier(guildId, member);
  if (!effective) return false;
  return TIERS[effective] >= TIERS[requiredTier];
}

/**
 * Middleware-Helper: prüft Tier, antwortet ephemeral wenn nicht erlaubt.
 * Bei DB-Failure: ephemeral "Datenbankfehler" + return false + console.error.
 * @returns {Promise<boolean>}  true wenn erlaubt, false wenn schon geantwortet
 */
async function requireTier(interaction, requiredTier) {
  if (!(requiredTier in TIERS)) {
    console.error(`[perms] requireTier called with unknown tier: '${requiredTier}'`);
    await interaction.reply({
      content: 'Interner Fehler — ungültiger Tier-Wert. Bitte den Bot-Admin informieren.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (!interaction.guildId) {
    await interaction.reply({
      content: 'Dieser Befehl funktioniert nur auf Servern.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const member = interaction.member;
  if (!member) {
    await interaction.reply({
      content: 'Member nicht gefunden — versuch es nochmal.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  let allowed;
  try {
    allowed = await hasTier(interaction.guildId, member, requiredTier);
  } catch (err) {
    console.error('[perms] requireTier DB error:', err);
    await interaction.reply({
      content: 'Datenbankfehler — versuch es später.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (!allowed) {
    await interaction.reply({
      content: `Du brauchst Tier '${requiredTier}' oder höher für diesen Befehl.`,
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

module.exports = {
  TIERS,
  getEffectiveTier,
  hasTier,
  requireTier,
};
