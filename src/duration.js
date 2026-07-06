const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // 28 days — Discord API limit
const MAX_TEMP_MS = 365 * 24 * 60 * 60 * 1000; // Obergrenze für Temp-Ban/Temp-Mute

/**
 * Parses a duration string like "30s", "10m", "2h", "1t", "1w".
 * Returns milliseconds or null if invalid. Empty string returns null.
 * "t" is German "Tag" (day).
 */
function parseDuration(str) {
  const match = str.trim().match(/^(\d+)\s*(s|m|h|t|d|w)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multipliers = { s: 1000, m: 60_000, h: 3_600_000, t: 86_400_000, d: 86_400_000, w: 604_800_000 };
  return value * multipliers[unit];
}

/**
 * Formats milliseconds into a human-readable German duration string.
 */
function formatDuration(ms) {
  const weeks = Math.floor(ms / 604_800_000);
  if (weeks > 0) return `${weeks} ${weeks === 1 ? 'Woche' : 'Wochen'}`;
  const days = Math.floor(ms / 86_400_000);
  if (days > 0) return `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours > 0) return `${hours} ${hours === 1 ? 'Stunde' : 'Stunden'}`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes > 0) return `${minutes} ${minutes === 1 ? 'Minute' : 'Minuten'}`;
  const seconds = Math.floor(ms / 1000);
  return `${seconds} ${seconds === 1 ? 'Sekunde' : 'Sekunden'}`;
}

module.exports = { parseDuration, formatDuration, MAX_TIMEOUT_MS, MAX_TEMP_MS };
