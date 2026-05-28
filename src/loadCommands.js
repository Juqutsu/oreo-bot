const { readdirSync } = require('node:fs');
const { join } = require('node:path');

function loadCommands() {
  const dir = join(__dirname, 'commands');
  const commands = new Map();

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const command = require(join(dir, file));
    if (!command?.data || !command?.execute) {
      console.warn(`[commands] skipping ${file}: missing "data" or "execute"`);
      continue;
    }
    commands.set(command.data.name, command);
  }

  return commands;
}

module.exports = { loadCommands };
