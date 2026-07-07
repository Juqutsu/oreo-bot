// Shared audit-log executor lookup for the *-log event handlers (channelCreate,
// channelDelete, channelUpdate, guildMemberUpdate, guildUpdate, roleCreate, roleDelete,
// roleUpdate, voiceStateUpdate). Extracted from 11 near-identical copies of the same
// "fetchAuditLogs -> find newest matching entry -> format executor tag" logic.

/**
 * @param {import('discord.js').Guild} guild - guild to fetch audit logs from
 * @param {number} auditLogEventType - AuditLogEvent enum value to filter the fetch on
 * @param {string} targetId - id the audit-log entry's targetId must equal
 * @param {object} [options]
 * @param {number} [options.windowMs=10000] - max age (ms) of a matching entry, relative to now
 * @param {number} [options.limit=5] - number of audit-log entries to fetch
 * @param {(entry: import('discord.js').GuildAuditLogsEntry) => boolean} [options.filter]
 *   optional extra predicate evaluated against each candidate entry, in addition to the
 *   targetId + window match (e.g. guildMemberUpdate's nickname-change site needs to confirm
 *   the entry actually changed the 'nick' key, not just any MemberUpdate entry for the same
 *   user within the window). Defaults to accepting any entry that matches targetId + window.
 * @param {string} [options.logContext] - console.warn message used on fetch failure; defaults
 *   to a generic prefix if the caller doesn't pass its own context
 * @returns {Promise<{ executorTag: string, executor: import('discord.js').User } | null>}
 *   null when no matching entry is found (or it has no resolvable executor), or the fetch fails
 */
async function resolveAuditExecutor(
  guild,
  auditLogEventType,
  targetId,
  { windowMs = 10_000, limit = 5, filter = () => true, logContext } = {}
) {
  try {
    const auditLogs = await guild.fetchAuditLogs({ type: auditLogEventType, limit });
    const logEntry = [...auditLogs.entries.values()].find(
      entry => entry.targetId === targetId &&
               (Date.now() - entry.createdTimestamp) < windowMs &&
               filter(entry)
    );
    if (logEntry && logEntry.executor) {
      return {
        executorTag: `<@${logEntry.executor.id}> (${logEntry.executor.tag})`,
        executor: logEntry.executor,
      };
    }
    return null;
  } catch (err) {
    console.warn(logContext ?? '[audit-executor] Failed to fetch audit logs:', err);
    return null;
  }
}

module.exports = { resolveAuditExecutor };
