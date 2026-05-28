const { REST, Routes } = require('discord.js');

async function deployCommands({ token, clientId, guildId, commands }) {
  const body = [...commands.values()].map((c) => c.data.toJSON());
  const rest = new REST().setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log(`Deployed ${body.length} command(s) to guild ${guildId}`);
}

module.exports = { deployCommands };
