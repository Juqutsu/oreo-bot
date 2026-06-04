const fs = require('node:fs');
const path = require('node:path');

/**
 * Auto-discovers every .js file under src/events/ and registers it on the
 * supplied Discord client. Each event module must export at minimum:
 *
 *   module.exports = { name: Events.<X>, execute: async (...args) => {} };
 *
 * Optional: `once: true` registers via client.once instead of client.on.
 *
 * If src/events/ does not exist this is a silent no-op — so adding the
 * call to index.js is safe even before the first event handler exists.
 */
function loadEvents(client) {
  const dir = path.join(__dirname, 'events');
  if (!fs.existsSync(dir)) return 0;

  let count = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const event = require(path.join(dir, file));
    if (!event?.name || typeof event.execute !== 'function') {
      console.warn(`[loadEvents] skipping ${file}: missing name or execute`);
      continue;
    }
    if (event.once) client.once(event.name, (...args) => event.execute(...args));
    else            client.on(event.name,   (...args) => event.execute(...args));
    count++;
  }
  return count;
}

module.exports = { loadEvents };
