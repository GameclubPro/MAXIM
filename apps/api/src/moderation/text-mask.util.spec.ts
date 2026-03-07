import { maskText } from './text-mask.util';

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;

    if (!isHigh && !isLow) {
      continue;
    }

    if (isHigh) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }

    return true;
  }

  return false;
}

describe('maskText', () => {
  it('returns short text as-is', () => {
    expect(maskText('тест')).toBe('тест');
  });

  it('truncates long text to a readable preview', () => {
    const source = 'а'.repeat(260);
    const masked = maskText(source);

    expect(masked).toHaveLength(220);
    expect(masked.endsWith('...')).toBe(true);
  });

  it('normalizes whitespace in preview', () => {
    expect(maskText('  ссылка   https://max.ru/test  ')).toBe('ссылка https://max.ru/test');
  });

  it('keeps emoji surrogate pairs intact', () => {
    expect(maskText('😀😀😀😀😀')).toBe('😀😀😀😀😀');
  });

  it('does not produce lone surrogate symbols', () => {
    const masked = maskText('🔥😄пример😄🔥');
    expect(hasLoneSurrogate(masked)).toBe(false);
  });
});
