const { getPool } = require('./db');
const cases = require('./cases');
const config = require('./config');
const { buildModLogEmbed } = require('./modlog');

async function runDecayAndExpiry(client) {
  const pool = getPool();

  // 1. Expired Temp-Bans
  try {
    const [expiredBans] = await pool.execute(
      "SELECT * FROM infractions WHERE type = 'ban' AND active = 1 AND expires_at IS NOT NULL AND expires_at < NOW()"
    );

    for (const ban of expiredBans) {
      const guildId = ban.guild_id.toString();
      const userId = ban.user_id.toString();

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (guild) {
        // Attempt to unban from Discord
        const unbanOk = await guild.members.unban(userId, 'Oreo: Temp-Ban abgelaufen').then(() => true).catch((err) => {
          if (err.code === 10026 || err.status === 404) {
            // Already unbanned or not banned, proceed
            return true;
          }
          console.error(`[background] Failed to unban user ${userId} in guild ${guildId}:`, err);
          return false;
        });

        if (unbanOk) {
          // Deactivate the old ban case
          await pool.execute('UPDATE infractions SET active = 0 WHERE id = ?', [ban.id]);

          // Create unban case
          let caseNumber;
          try {
            const result = await cases.createCase({
              guildId,
              userId,
              moderatorId: client.user.id,
              type: 'unban',
              reason: 'Temp-Ban abgelaufen',
              source: 'system',
            });
            caseNumber = result.caseNumber;
          } catch (e) {
            console.error('[background] createCase failed for temp-ban expiry unban:', e);
            caseNumber = null;
          }

          // Send to modlog
          try {
            const channelId = await config.getModLogChannelId(guildId);
            if (channelId) {
              const logChannel = await guild.channels.fetch(channelId).catch(() => null);
              const targetUser = await client.users.fetch(userId).catch(() => null);
              if (logChannel && targetUser) {
                const embed = buildModLogEmbed({
                  action: 'unban',
                  caseNumber,
                  target: targetUser,
                  mod: client.user,
                  reason: 'Temp-Ban abgelaufen',
                });
                await logChannel.send({ embeds: [embed] }).catch(() => null);
              }
            }
          } catch (logErr) {
            console.warn('[background] Modlog post failed for unban expiry:', logErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('[background] Error processing expired bans:', err);
  }

  // 2. Expired Mutes
  try {
    const [expiredMutes] = await pool.execute(
      "SELECT * FROM infractions WHERE type = 'mute' AND active = 1 AND expires_at IS NOT NULL AND expires_at < NOW()"
    );

    for (const mute of expiredMutes) {
      const guildId = mute.guild_id.toString();
      const userId = mute.user_id.toString();

      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (guild) {
        const mutedRoleId = await config.getMutedRoleId(guildId);
        const member = await guild.members.fetch(userId).catch(() => null);

        let unmuteOk = true;
        if (member && mutedRoleId) {
          unmuteOk = await member.roles.remove(mutedRoleId, 'Oreo: Mute abgelaufen').then(() => true).catch((err) => {
            console.error(`[background] Failed to remove Muted role from ${userId} in ${guildId}:`, err);
            return false;
          });
        }

        if (unmuteOk) {
          // Deactivate old mute case
          await pool.execute('UPDATE infractions SET active = 0 WHERE id = ?', [mute.id]);

          // Create unmute case
          let caseNumber;
          try {
            const result = await cases.createCase({
              guildId,
              userId,
              moderatorId: client.user.id,
              type: 'unmute',
              reason: 'Stummschaltung abgelaufen',
              source: 'system',
            });
            caseNumber = result.caseNumber;
          } catch (e) {
            console.error('[background] createCase failed for mute expiry unmute:', e);
            caseNumber = null;
          }

          // Send to modlog
          try {
            const channelId = await config.getModLogChannelId(guildId);
            if (channelId) {
              const logChannel = await guild.channels.fetch(channelId).catch(() => null);
              const targetUser = await client.users.fetch(userId).catch(() => null);
              if (logChannel && targetUser) {
                const embed = buildModLogEmbed({
                  action: 'unmute',
                  caseNumber,
                  target: targetUser,
                  mod: client.user,
                  reason: 'Stummschaltung abgelaufen',
                });
                await logChannel.send({ embeds: [embed] }).catch(() => null);
              }
            }
          } catch (logErr) {
            console.warn('[background] Modlog post failed for unmute expiry:', logErr);
          }
        }
      }
    }
  } catch (err) {
    console.error('[background] Error processing expired mutes:', err);
  }

  // 3. Expire Timeouts (no Discord I/O — Discord lifts timeouts itself)
  try {
    const [timeoutResult] = await pool.execute(
      "UPDATE infractions SET active = 0 WHERE type = 'timeout' AND active = 1 AND expires_at IS NOT NULL AND expires_at < NOW()"
    );
    if (timeoutResult.affectedRows > 0) {
      console.log(`[background] Deactivated ${timeoutResult.affectedRows} expired timeout case(s).`);
    }
  } catch (err) {
    console.error('[background] Error processing expired timeouts:', err);
  }

  // 4. Warn Decay (bulk update)
  try {
    const [decayResult] = await pool.execute(`
      UPDATE infractions i
        JOIN guilds g ON i.guild_id = g.guild_id
         SET i.active = 0
       WHERE i.type = 'warn'
         AND i.active = 1
         AND g.warn_decay_days > 0
         AND i.created_at < DATE_SUB(NOW(), INTERVAL g.warn_decay_days DAY)
    `);
    if (decayResult.affectedRows > 0) {
      console.log(`[background] Warn decay: marked ${decayResult.affectedRows} warn infraction(s) as inactive.`);
    }
  } catch (err) {
    console.error('[background] Error processing warn decay:', err);
  }
}

function startBackgroundTasks(client) {
  console.log('[background] Starting background checks loop (60s interval)...');
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDecayAndExpiry(client);
    } catch (err) {
      console.error('[background] Uncaught error in runDecayAndExpiry interval loop:', err);
    } finally {
      running = false;
    }
  }, 60000);
}

module.exports = { startBackgroundTasks, runDecayAndExpiry };
