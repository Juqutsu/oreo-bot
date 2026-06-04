const { Events } = require('discord.js');

async function execute(member) {
  if (member.user.bot) return;

  const guild = member.guild;

  try {
    const channels = await guild.channels.fetch();
    const verifyChan = channels.find(
      (c) => c.name === `verify-${member.user.id}`
    );
    if (verifyChan) {
      await verifyChan.delete('Oreo: User hat den Server verlassen.').catch(() => null);
    }
  } catch (err) {
    console.error('[guildMemberRemove] failed to clean up verification channel:', err);
  }
}

module.exports = {
  name: Events.GuildMemberRemove,
  execute,
};
