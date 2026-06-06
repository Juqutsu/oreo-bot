const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { PermissionFlagsBits } = require('discord.js');

const TIER_PERMISSIONS = {
  owner: PermissionFlagsBits.Administrator,
  moderator: PermissionFlagsBits.BanMembers,
  supporter: PermissionFlagsBits.ModerateMembers,
};

function loadCommands() {
  const dir = join(__dirname, 'commands');
  const commands = new Map();

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const command = require(join(dir, file));
    if (!command?.data || !command?.execute) {
      console.warn(`[commands] skipping ${file}: missing "data" or "execute"`);
      continue;
    }

    // Dynamic visibility controls mapping to Discord default permissions
    if (command.requiredTier) {
      const perm = TIER_PERMISSIONS[command.requiredTier];
      if (perm !== undefined) {
        command.data.setDefaultMemberPermissions(perm);
      }
    } else if (command.data.name === 'setup') {
      // /setup has no requiredTier, but is restricted to Server Owners.
      command.data.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
    }

    // Force DM execution disabled for all commands
    command.data.setDMPermission(false);

    commands.set(command.data.name, command);
  }

  return commands;
}

module.exports = { loadCommands };
