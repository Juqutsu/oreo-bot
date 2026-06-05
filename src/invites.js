const inviteCache = new Map(); // guildId -> Map(code -> uses)

/**
 * Caches all current invites for a guild.
 * @param {import('discord.js').Guild} guild
 */
async function cacheGuildInvites(guild) {
  try {
    const botMember = guild.members.me ?? await guild.members.fetch(guild.client.user.id).catch(() => null);
    if (!botMember || !botMember.permissions.has('ManageGuild')) return;

    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return;

    const guildInvites = new Map();
    for (const invite of invites.values()) {
      guildInvites.set(invite.code, invite.uses ?? 0);
    }
    inviteCache.set(guild.id, guildInvites);
  } catch (err) {
    console.warn(`[invites] Failed to cache invites for guild ${guild.id}:`, err.message);
  }
}

/**
 * Compares current invites with cached ones to find which invite was used.
 * Automatically updates the cache.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<import('discord.js').Invite|null>}
 */
async function findUsedInvite(guild) {
  try {
    const botMember = guild.members.me ?? await guild.members.fetch(guild.client.user.id).catch(() => null);
    if (!botMember || !botMember.permissions.has('ManageGuild')) return null;

    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;

    const cached = inviteCache.get(guild.id);
    
    // Update cache with fresh values
    inviteCache.set(guild.id, new Map(invites.map((i) => [i.code, i.uses ?? 0])));

    if (!cached) return null;

    for (const invite of invites.values()) {
      const prevUses = cached.get(invite.code) ?? 0;
      if ((invite.uses ?? 0) > prevUses) {
        return invite;
      }
    }
  } catch (err) {
    console.warn(`[invites] Failed to track invite usage for guild ${guild.id}:`, err.message);
  }
  return null;
}

module.exports = {
  cacheGuildInvites,
  findUsedInvite,
  inviteCache,
};
