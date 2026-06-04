/**
 * Cleans and normalizes message text to uncover obfuscated swear/bad words.
 *
 * Steps:
 * 1. Convert to lowercase.
 * 2. Convert common leetspeak characters back to letters.
 * 3. Remove all non-alphanumeric characters (symbols, dots, underscores, spaces, etc.).
 * 4. Remove consecutive duplicate letters (e.g., 'baaaaad' -> 'bad').
 *
 * @param {string} text Raw message content
 * @returns {string} Fully normalized string
 */
function normalize(text) {
  if (!text) return '';

  let normalized = text.toLowerCase();

  // Leetspeak normalization
  const leetMap = {
    '0': 'o',
    '1': 'i',
    '!': 'i',
    '|': 'i',
    '3': 'e',
    '4': 'a',
    '@': 'a',
    '5': 's',
    '$': 's',
    '7': 't',
    '8': 'b',
    '9': 'g',
  };

  let replaced = '';
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    replaced += leetMap[char] ?? char;
  }
  normalized = replaced;

  // Remove non-alphanumeric characters
  // Keep only a-z and 0-9
  normalized = normalized.replace(/[^a-z0-9]/g, '');

  // Remove consecutive duplicate letters (e.g. 'baaadd' -> 'bad')
  normalized = normalized.replace(/(.)\1+/g, '$1');

  return normalized;
}

module.exports = { normalize };
