import { describe, expect, it } from 'vitest';
import {
  normalizeStopWordsDomain,
  stopWordsPolicySchema,
  stopWordsRuleSchema,
  updateStopWordsRequestSchema,
  stopWordsStateSchema,
  stopWordsStatusSchema,
} from '../src/stop-words.js';

describe('stop-word policy contract', () => {
  it('defaults to disabled exact rules without participant sanctions', () => {
    const policy = stopWordsPolicySchema.parse({
      rules: [{ id: 'one', kind: 'WORD', value: 'Ёлка' }],
    });
    expect(policy.enabled).toBe(false);
    expect(policy.imageScanEnabled).toBe(false);
    expect(policy.rules[0]).toMatchObject({ value: 'Ёлка', matchMode: 'EXACT', enabled: true });
    expect(policy.sanctions).toMatchObject({
      warnEnabled: false,
      muteEnabled: false,
      banEnabled: false,
    });
  });
  it('keeps a phrase as one rule and preserves its authored spelling', () => {
    expect(
      stopWordsRuleSchema.parse({ id: 'one', kind: 'PHRASE', value: 'Доход  без вложений' }).value,
    ).toBe('Доход без вложений');
    expect(
      stopWordsRuleSchema.parse({ id: 'two', kind: 'WORD', value: 'ＣＡＳＩＮＯ' }).value,
    ).toBe('ＣＡＳＩＮＯ');
  });
  it.each([
    '',
    'x',
    'a'.repeat(161),
    'word '.repeat(17).trim(),
    'и/в',
    'casino.example',
    'foo\u200bbar',
  ])('rejects invalid rule %s', (value) => {
    expect(
      stopWordsRuleSchema.safeParse({
        id: 'one',
        kind: value.includes(' ') ? 'PHRASE' : 'WORD',
        value,
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate normalized values and IDs', () => {
    for (const rules of [
      [
        { id: 'one', kind: 'WORD', value: 'Ёлка' },
        { id: 'two', kind: 'WORD', value: 'елка' },
      ],
      [
        { id: 'one', kind: 'WORD', value: 'один' },
        { id: 'one', kind: 'WORD', value: 'два' },
      ],
    ])
      expect(stopWordsPolicySchema.safeParse({ rules }).success).toBe(false);
  });
  it('normalizes domains without broadening a configured www host', () => {
    expect(normalizeStopWordsDomain('https://www.example.com/page')).toBe('www.example.com');
    expect(normalizeStopWordsDomain('https://пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(normalizeStopWordsDomain('bad_domain.example')).toBe(null);
  });
  it('requires a revision on every scoped write', () => {
    expect(updateStopWordsRequestSchema.safeParse({ policy: {} }).success).toBe(false);
  });
  it('adds optional storage health only to the full response', () => {
    const response = { policy: {}, revision: 3, imageScanStatus: 'unavailable' };
    expect(stopWordsStateSchema.parse(response).storageStatus).toBeUndefined();
    expect(
      stopWordsStateSchema.parse({ ...response, settingsRevision: '2026-10-29T16:00:00.000Z' })
        .settingsRevision,
    ).toBe('2026-10-29T16:00:00.000Z');
    for (const storageStatus of ['valid', 'legacy', 'invalid']) {
      expect(stopWordsStateSchema.parse({ ...response, storageStatus }).storageStatus).toBe(
        storageStatus,
      );
      expect(
        stopWordsStatusSchema.parse({
          ...response,
          storageStatus,
          settingsRevision: '2026-10-29T16:00:00.000Z',
        }),
      ).toEqual({
        revision: 3,
        imageScanStatus: 'unavailable',
      });
    }
    expect(stopWordsStateSchema.safeParse({ ...response, storageStatus: 'unknown' }).success).toBe(
      false,
    );
  });
});
