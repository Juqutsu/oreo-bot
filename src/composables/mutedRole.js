const config = require('../config');

/**
 * Löst die Muted-Rolle rein lesend auf (konfigurierte ID oder Namens-Fallback "Muted"),
 * OHNE sie bei Fehlen neu anzulegen. Für Kontexte wie Join-Events gedacht, in denen das
 * Anlegen einer neuen Rolle (inkl. Channel-Overwrites) ein unerwünschter Seiteneffekt wäre.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').Role|null>}
 */
async function getMutedRole(guild) {
  const guildId = guild.id;
  const roleId = await config.getMutedRoleId(guildId);

  if (roleId) {
    const role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
    if (role) return role;
  }

  return guild.roles.cache.find((r) => r.name === 'Muted') || null;
}

/**
 * Holt die Muted-Rolle oder erstellt sie, falls sie nicht existiert,
 * und konfiguriert die entsprechenden Berechtigungen in allen Channels.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').Role|null>}
 */
async function getOrCreateMutedRole(guild) {
  const guildId = guild.id;
  let roleId = await config.getMutedRoleId(guildId);
  let role = null;

  if (roleId) {
    role = guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
  }

  if (!role) {
    role = guild.roles.cache.find((r) => r.name === 'Muted') || null;
    if (role) {
      await config.setMutedRoleId(guildId, role.id);
    }
  }

  if (!role) {
    role = await guild.roles.create({
      name: 'Muted',
      color: 0x818386,
      reason: 'Oreo Muted-Rolle Setup',
    }).catch((err) => {
      console.error('Konnte Muted-Rolle nicht erstellen:', err);
      return null;
    });

    if (role) {
      await config.setMutedRoleId(guildId, role.id);

      // Edit channel overwrites (best-effort)
      const channels = await guild.channels.fetch().catch(() => new Map());
      for (const [_, channel] of channels) {
        if (channel.isTextBased() || channel.isVoiceBased()) {
          await channel.permissionOverwrites.create(role, {
            SendMessages: false,
            AddReactions: false,
            Speak: false,
          }, { reason: 'Oreo Muted-Rolle Setup' }).catch(() => null);
        }
      }
    }
  }

  return role;
}

module.exports = { getOrCreateMutedRole, getMutedRole };
