function normalize(text) {
  if (!text) return '';

  let normalized = text.toLowerCase();

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

  normalized = normalized.replace(/[^a-z0-9]/g, '');

  normalized = normalized.replace(/(.)\1+/g, '$1');

  return normalized;
}

module.exports = { normalize };
