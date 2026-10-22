import { majorNetworksEnabled } from './major-networks-rollout';

describe('Major networks rollout', () => {
  const testers = new Set(['tester']);
  it('starts hidden, admits only the test cohort, and preserves Publisher boundaries', () => {
    for (const mode of [undefined, 'off', 'invalid']) {
      expect(majorNetworksEnabled(mode, 'moderation', 'tester', testers)).toBe(false);
    }
    expect(majorNetworksEnabled('test', 'moderation', 'tester', testers)).toBe(true);
    expect(majorNetworksEnabled('test', 'moderation', 'other', testers)).toBe(false);
    expect(majorNetworksEnabled('on', 'moderation', 'other', testers)).toBe(true);
    for (const mode of ['test', 'on']) {
      expect(majorNetworksEnabled(mode, 'publisher', 'tester', testers)).toBe(false);
    }
  });
});
