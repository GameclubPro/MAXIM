import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  migrateStopWordsPolicy,
  readStopWordsPolicy,
  withStopWordsSanctions,
  stopWordsPolicyStorage,
} from './stop-words.policy';

describe('stop-word policy migration', () => {
  it('does not treat object prototype names as preset phrases', () => {
    expect(
      migrateStopWordsPolicy({ messageLimitsBlockedWords: ['constructor'] }).rules[0]?.value,
    ).toBe('constructor');
  });
  it('preserves the effective value of legacy punctuation-wrapped entries', () => {
    expect(
      migrateStopWordsPolicy({ messageLimitsBlockedWords: ['"CASINO"'] }).rules[0]?.value,
    ).toBe('casino');
  });
  it('stores media separately from enforcement policy and restores it on reads', () => {
    const policy = stopWordsPolicySchema.parse({
      sanctions: {
        media: { explanation: { base64: 'AQ==', mimeType: 'image/png', fileName: 'notice.png' } },
      },
    });
    const stored = stopWordsPolicyStorage(policy);
    expect(JSON.stringify(stored.stopWordsPolicy)).not.toContain('AQ==');
    expect(readStopWordsPolicy(stored)).toEqual(policy);
  });
  it('keeps explicit lists, expands only reviewed phrases and assigns stable identities', () => {
    const legacy = {
      messageLimitsBlockedWords: ['casino', 'доходбезвложений', 'мойнеизвестныймаркер'],
      messageLimitsBlockedDomains: ['example.com'],
      messageLimitsWarnEnabled: true,
      messageLimitsMuteEnabled: true,
      messageLimitsMuteDurationHours: 12,
      messageLimitsBotMessageText: 'notice',
      messageLimitsWarnMessageText: 'warning',
    };
    const policy = migrateStopWordsPolicy(legacy);
    expect(policy).toEqual(migrateStopWordsPolicy(legacy));
    expect(policy.rules.map((rule) => rule.value)).toEqual([
      'casino',
      'доход без вложений',
      'мойнеизвестныймаркер',
    ]);
    expect(policy.rules.every((rule) => rule.matchMode === 'EXACT')).toBe(true);
    expect(policy.sanctions).toMatchObject({
      warnEnabled: true,
      muteEnabled: true,
      muteDurationHours: 12,
      botMessageText: 'notice',
      warnMessageText: 'warning',
    });
  });
  it('does not inherit subsequent changes to general limits', () => {
    const policy = stopWordsPolicySchema.parse({ sanctions: { muteDurationHours: 12 } });
    expect(
      migrateStopWordsPolicy({ stopWordsPolicy: policy, messageLimitsMuteDurationHours: 48 })
        .sanctions.muteDurationHours,
    ).toBe(12);
  });
  it('fails closed on malformed policies without re-enabling a legacy list', () => {
    expect(readStopWordsPolicy({ stopWordsPolicy: { version: 99 } })?.enabled).toBe(false);
  });
  it('projects independent sanctions without mutating the shared settings', () => {
    const settings = {
      messageLimitsWarnEnabled: true,
      messageLimitsMuteDurationHours: 48,
      botSpeechMedia: {},
    } as never;
    const policy = stopWordsPolicySchema.parse({ sanctions: { muteDurationHours: 12 } });
    const projected = withStopWordsSanctions(settings, policy);
    expect(projected).toMatchObject({
      messageLimitsWarnEnabled: false,
      messageLimitsMuteDurationHours: 12,
    });
    expect(settings).toMatchObject({
      messageLimitsWarnEnabled: true,
      messageLimitsMuteDurationHours: 48,
    });
  });
});
