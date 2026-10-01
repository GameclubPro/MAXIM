import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import {
  CommercialTextRuntimePolicyService,
  COMMERCIAL_TEXT_CONTROL_KEY,
} from './commercial-text-runtime-policy.service';

function harness() {
  const redis = {
    getString: jest.fn().mockResolvedValue(null),
    compareAndSetRevisionedControl: jest.fn().mockResolvedValue({ applied: true, revision: 1 }),
  };
  return { redis, service: new CommercialTextRuntimePolicyService(redis as never) };
}
const control = (mode = 'canary') => ({
  detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
  decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
  holdoutArtifactSha256: 'a'.repeat(64),
  settingsProfileDigests: ['b'.repeat(64)],
  version: 2 as const,
  revision: 1,
  mode: mode as 'canary',
  chatIds: ['test-chat'],
  promotedPolicyCohorts: ['owned-service-contrast-v1' as const],
  effectiveAt: new Date(Date.now() - 1000).toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

describe('commercial text shared authority', () => {
  it('runs the released deterministic rules without an experimental control', async () => {
    await expect(harness().service.authority('chat')).resolves.toMatchObject({
      baselineAllowed: true,
      promotedPolicyCohorts: ['owned-service-contrast-v1', 'sliding-campaign-v1'],
      revision: 0,
    });
  });
  it.each(['shadow', 'baseline', 'off', 'canary', 'on'])(
    'enforces %s with explicit cohort membership',
    async (mode) => {
      const h = harness();
      h.redis.getString.mockImplementation(async (key) =>
        key === COMMERCIAL_TEXT_CONTROL_KEY ? JSON.stringify(control(mode)) : '1',
      );
      const selected = await h.service.authority('test-chat', 'b'.repeat(64));
      const other = await h.service.authority('other-chat', 'b'.repeat(64));
      expect(selected.baselineAllowed).toBe(mode !== 'off');
      expect(selected.promotedPolicyCohorts.length).toBe(
        mode === 'baseline' ? 2 : ['canary', 'on'].includes(mode) ? 1 : 0,
      );
      expect(other.promotedPolicyCohorts.length).toBe(
        mode === 'baseline' ? 2 : mode === 'on' ? 1 : 0,
      );
    },
  );
  it.each(['malformed', 'mismatch', 'transport'])(
    'fails unknown %s authority closed',
    async (failure) => {
      const h = harness();
      if (failure === 'transport') h.redis.getString.mockRejectedValue(new Error('offline'));
      else
        h.redis.getString.mockImplementation(async (key) =>
          key === COMMERCIAL_TEXT_CONTROL_KEY
            ? failure === 'malformed'
              ? '{}'
              : JSON.stringify(control())
            : '2',
        );
      await expect(h.service.authority('test-chat', 'b'.repeat(64))).resolves.toMatchObject({
        baselineAllowed: false,
        promotedPolicyCohorts: [],
        mode: 'unavailable',
      });
    },
  );
  it('does not lend expired recall to new deletes and checks revision on write', async () => {
    const h = harness();
    h.redis.getString.mockImplementation(async (key) =>
      key === COMMERCIAL_TEXT_CONTROL_KEY
        ? JSON.stringify({ ...control(), expiresAt: new Date(Date.now() - 1).toISOString() })
        : '1',
    );
    await expect(h.service.authority('test-chat', 'b'.repeat(64))).resolves.toMatchObject({
      baselineAllowed: true,
      promotedPolicyCohorts: ['owned-service-contrast-v1', 'sliding-campaign-v1'],
      revision: 1,
    });
    await expect(h.service.set(control(), 1)).rejects.toThrow('revision');
    expect(h.redis.compareAndSetRevisionedControl).not.toHaveBeenCalled();
  });
  it('requires finite promotion lifetime and explicit canary chats', async () => {
    const h = harness();
    await expect(h.service.set({ ...control(), expiresAt: null }, 0)).rejects.toThrow('finite');
    await expect(h.service.set({ ...control(), chatIds: [] }, 0)).rejects.toThrow('explicit');
    await expect(h.service.set(control(), 0)).resolves.toMatchObject({
      applied: true,
      revision: 1,
    });
  });
});
