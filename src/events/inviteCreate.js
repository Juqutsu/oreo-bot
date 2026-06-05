const { Events } = require('discord.js');
const invitesTracker = require('../invites');

async function execute(invite) {
  if (!invite.guild) return;
  const cached = invitesTracker.inviteCache.get(invite.guild.id);
  if (cached) {
    cached.set(invite.code, invite.uses ?? 0);
  }
}

module.exports = {
  name: Events.InviteCreate,
  execute,
};
