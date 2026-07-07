const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const { TIER_PERMISSIONS } = require('./perms');

function loadCommands() {
  const dir = join(__dirname, 'commands');
  const commands = new Map();

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const command = require(join(dir, file));
    if (!command?.data || !command?.execute) {
      console.warn(`[commands] skipping ${file}: missing "data" or "execute"`);
      continue;
    }

    // Dynamic visibility controls mapping to Discord default permissions.
    // A command may export defaultMemberPermissions explicitly (e.g. /setup,
    // which has no requiredTier); otherwise fall back to the tier registry.
    if (command.defaultMemberPermissions !== undefined) {
      command.data.setDefaultMemberPermissions(command.defaultMemberPermissions);
    } else if (command.requiredTier) {
      const perm = TIER_PERMISSIONS[command.requiredTier];
      if (perm !== undefined) {
        command.data.setDefaultMemberPermissions(perm);
      }
    }

    // Force DM execution disabled for all commands
    command.data.setDMPermission(false);

    commands.set(command.data.name, command);
  }

  return commands;
}

module.exports = { loadCommands };
