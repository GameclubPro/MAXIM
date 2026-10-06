import { WebhookParser } from '../webhook/webhook.parser';
import { inspectLegacyRecoverySource } from '../webhook/webhook-legacy-source';
import { legacyRecoveryLiveDigest } from './legacy-recovery-live-protocol';
import {
  LEGACY_RECOVERY_SOURCE_CLOSURE,
  legacyRecoverySourceClosureDigest,
} from './legacy-recovery-source-closure';

function source(attachment?: unknown, text = 'Ordinary original caption') {
  const timestamp = Date.UTC(2026, 9, 5, 19);
  const raw = {
    update_type: 'message_created',
    timestamp,
    message: {
      sender: { user_id: 'source-human', is_bot: false },
      recipient: { chat_id: '-source-chat', chat_type: 'chat' },
      timestamp,
      body: {
        mid: 'source-message',
        text,
        ...(attachment === undefined ? {} : { attachments: [attachment] }),
      },
    },
  };
  return {
    botId: 'major',
    createdAt: new Date(timestamp + 1),
    rawPayload: raw,
    normalizedPayload: new WebhookParser().parse(raw, { botId: 'major' }),
  };
}

describe('reviewed legacy source closure identity', () => {
  it.each([
    { type: 'image', payload: { photo_id: 42, url: 'https://example.test/photo' } },
    {
      type: 'video',
      payload: { id: 42, token: 'synthetic', url: 'https://example.test/video' },
    },
  ])('describes the existing $type classifier without adding a source target', (attachment) => {
    expect(LEGACY_RECOVERY_SOURCE_CLOSURE.excluded).not.toContain('direct-media');
    expect(LEGACY_RECOVERY_SOURCE_CLOSURE.source).toContain('direct-photos-or-videos');
    const expected = inspectLegacyRecoverySource(source() as never);
    expect(expected).not.toBeNull();
    expect(inspectLegacyRecoverySource(source(attachment) as never)).toEqual(expected);
    expect(inspectLegacyRecoverySource(source(attachment, '/ban') as never)).toBeNull();
  });

  it.each(['audio', 'file', 'contact', 'inline_keyboard', 'unknown'])(
    'preserves refusal of unsupported direct %s content',
    (type) => {
      expect(LEGACY_RECOVERY_SOURCE_CLOSURE.excluded).toContain('non-image-or-video-direct-media');
      expect(
        inspectLegacyRecoverySource(
          source({ type, payload: { url: 'https://example.test/unsupported' } }) as never,
        ),
      ).toBeNull();
    },
  );

  it('requires a new attested digest for the corrected source class on the same runtime', () => {
    const sourceSha = 'a'.repeat(40);
    const imageId = `sha256:${'b'.repeat(64)}`;
    const oldClosure = {
      ...LEGACY_RECOVERY_SOURCE_CLOSURE,
      version: 2,
      source: 'original-human-text-or-flat-forwarded-photos-major-chat',
      excluded: LEGACY_RECOVERY_SOURCE_CLOSURE.excluded.map((value) =>
        value === 'non-image-or-video-direct-media' ? 'direct-media' : value,
      ),
    };
    const current = legacyRecoverySourceClosureDigest(sourceSha, imageId);
    expect(current).not.toBe(legacyRecoveryLiveDigest({ sourceSha, imageId, closure: oldClosure }));
    expect(current).not.toBe(legacyRecoverySourceClosureDigest('c'.repeat(40), imageId));
    expect(current).not.toBe(
      legacyRecoverySourceClosureDigest(sourceSha, `sha256:${'d'.repeat(64)}`),
    );
  });
});
