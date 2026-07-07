// Shared target validation for moderation commands.
//
// Each action keeps its own (pre-existing) German denial texts — they
// intentionally differ per command, so they live in a per-action registry
// instead of being homogenized. A `null` entry disables that guard for the
// action (e.g. /unmute has no bot-self guard).
//
// Guard order (matches the order the commands used inline):
// fetch member → not-a-member (if requireMember) → self → bot itself →
// guild owner → moderator-vs-target role hierarchy → bot action-ability
// (bannable/kickable/moderatable).

const DEFAULT_NOT_MEMBER = 'Dieser User ist nicht (mehr) auf dem Server.';

const ACTION_RULES = {
  ban: {
    self: 'Selbst-Ban geht nicht.',
    bot: 'Oreo kann sich nicht selber bannen.',
    owner: 'Den Server-Inhaber kannst du nicht bannen.',
    hierarchy: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
    abilityProp: 'bannable',
    ability: 'Diese Person lässt sich nicht bannen. Vermutlich ist Oreos Rolle nicht hoch genug.',
  },
  kick: {
    self: 'Selbst-Kick geht nicht.',
    bot: 'Oreo kann sich nicht selber kicken.',
    owner: 'Den Server-Inhaber kannst du nicht kicken.',
    hierarchy: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
    abilityProp: 'kickable',
    ability: 'Diese Person lässt sich nicht kicken. Vermutlich ist Oreos Rolle nicht hoch genug.',
  },
  softban: {
    self: 'Selbst-Softban geht nicht.',
    bot: 'Oreo kann sich nicht selber soft-bannen.',
    owner: 'Den Server-Inhaber kannst du nicht soft-bannen.',
    hierarchy: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
    abilityProp: 'bannable',
    ability: 'Diese Person lässt sich nicht bannen/soft-bannen. Vermutlich ist Oreos Rolle nicht hoch genug.',
  },
  mute: {
    notMember: 'Dieser User ist nicht (mehr) auf dem Server.',
    self: 'Selbst-Mute geht nicht.',
    bot: 'Oreo kann sich nicht selber stummschalten.',
    owner: 'Den Server-Inhaber kannst du nicht stummschalten.',
    hierarchy: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
    // Muted-role resolution/hierarchy checks stay in mute.js (role-based, not member-based).
  },
  warn: {
    notMember: 'Dieser User ist nicht (mehr) auf dem Server.',
    self: 'Selbst-Verwarnung geht nicht.',
    bot: 'Oreo kann sich nicht selber verwarnen.',
    owner: 'Den Server-Inhaber kannst du nicht verwarnen.',
    hierarchy: 'Diese Person hat dieselbe oder eine höhere Rolle als du.',
  },
  timeout: {
    notMember: 'Dieses Mitglied ist nicht auf dem Server.',
    self: 'Du kannst dir selbst keinen Timeout geben.',
    bot: 'Ich kann mir selbst keinen Timeout geben.',
    owner: 'Der Server-Inhaber kann keinen Timeout bekommen.',
    hierarchy: 'Du kannst Mitglieder mit gleicher oder höherer Rolle nicht timeouten.',
    abilityProp: 'moderatable',
    ability: 'Ich kann dieses Mitglied nicht timeouten (fehlende Berechtigungen).',
  },
  unmute: {
    notMember: 'Dieser User ist nicht (mehr) auf dem Server.',
    self: 'Du kannst dich nicht selbst entmuten.',
    bot: null, // /unmute never had a bot-self guard — unmuting the bot is harmless.
    owner: 'Der Server-Inhaber kann nicht entmutet werden.',
    hierarchy: 'Du kannst dieses Mitglied nicht entmuten (Rollen-Hierarchie).',
  },
};

/**
 * Runs the standard moderation-target guards for a command.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('discord.js').User} target target user (from options)
 * @param {object} opts
 * @param {keyof ACTION_RULES} opts.action which command's rules/texts to apply
 * @param {boolean} [opts.requireMember=true] false for actions that work on
 *   non-members (ban/softban work via ID even after the user left)
 * @returns {Promise<{ ok: true, targetMember: import('discord.js').GuildMember|null } | { ok: false, message: string }>}
 */
async function validateModTarget(interaction, target, { action, requireMember = true }) {
  const rules = ACTION_RULES[action];
  if (!rules) {
    throw new Error(`[modGuards] validateModTarget called with unknown action: '${action}'`);
  }

  const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
  const moderator = interaction.member;

  if (requireMember && !targetMember) {
    return { ok: false, message: rules.notMember ?? DEFAULT_NOT_MEMBER };
  }

  if (target.id === moderator.id) {
    return { ok: false, message: rules.self };
  }

  if (rules.bot && target.id === interaction.client.user.id) {
    return { ok: false, message: rules.bot };
  }

  if (target.id === interaction.guild.ownerId) {
    return { ok: false, message: rules.owner };
  }

  if (targetMember && moderator.roles.highest.comparePositionTo(targetMember.roles.highest) <= 0) {
    return { ok: false, message: rules.hierarchy };
  }

  if (rules.abilityProp && targetMember && !targetMember[rules.abilityProp]) {
    return { ok: false, message: rules.ability };
  }

  return { ok: true, targetMember };
}

module.exports = { validateModTarget };
