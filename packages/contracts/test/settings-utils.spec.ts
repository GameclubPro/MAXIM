import { describe, expect, it } from 'vitest';

import { normalizeAllowlistLink } from '@maxim/contracts';

describe('allowlist URL normalization', () => {
  it('removes the complete supported trailing punctuation set', () => {
    expect(normalizeAllowlistLink('Ссылка: https://example.com/path)]},.;!?:')).toBe(
      'https://example.com/path',
    );
    expect(normalizeAllowlistLink('https://example.com/a!b')).toBe('https://example.com/a!b');
  });

  it('handles adversarial trailing punctuation in a linear pass', () => {
    const repeatedPunctuation = '!'.repeat(100_000);
    const embeddedPunctuationUrl = `https://example.com/path${repeatedPunctuation}tail`;

    expect(normalizeAllowlistLink(`https://example.com/path${repeatedPunctuation}`)).toBe(
      'https://example.com/path',
    );
    expect(normalizeAllowlistLink(embeddedPunctuationUrl)).toBe(embeddedPunctuationUrl);
  });
});
