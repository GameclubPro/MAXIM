import { WebhookParser } from '../webhook/webhook.parser';
import {
  inspectLegacyRecoverySource,
  legacySnapshotDigest,
} from '../webhook/webhook-legacy-source';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { inspectLegacyRecoveryMirror } from './legacy-recovery-live-sql';

function fixture() {
  const at = Date.UTC(2026, 9, 5, 19);
  const raw = {
    update_type: 'message_created',
    timestamp: at,
    message: {
      sender: { user_id: 'human', is_bot: false },
      recipient: { chat_id: '-chat', chat_type: 'chat' },
      timestamp: at,
      body: {
        mid: 'message',
        text: 'Ordinary original',
        attachments: [
          {
            type: 'video',
            payload: {
              id: 9223372036854000000,
              url: 'https://example.test/owner',
              token: 'private-owner-token',
            },
            thumbnail: { url: 'https://example.test/preview' },
          },
        ],
      },
    },
  };
  const owner = {
    botId: 'major',
    createdAt: new Date(at + 1000),
    rawPayload: {},
    normalizedPayload: new WebhookParser().parse(raw, { botId: 'major' }),
  };
  const candidate = {
    owner,
    source: inspectLegacyRecoverySource(owner as never)!,
    claim: { semanticKey: buildWebhookSemanticEventKey(owner.normalizedPayload)! },
  };
  const mirrorRaw = structuredClone(raw);
  mirrorRaw.message.body.attachments[0]!.payload.url = 'https://example.test/mirror';
  mirrorRaw.message.body.attachments[0]!.payload.token = 'private-mirror-token';
  const mirror = {
    botId: 'major-mirror',
    createdAt: owner.createdAt,
    rawPayload: {},
    normalizedPayload: new WebhookParser().parse(mirrorRaw, { botId: 'major-mirror' }),
  };
  const metadata = { bot_id: 'major-mirror', semantic_key: candidate.claim.semanticKey };
  const inspect = () =>
    inspectLegacyRecoveryMirror(candidate as never, mirror, metadata, ['major', 'major-mirror']);
  const reparse = () => {
    mirror.normalizedPayload = new WebhookParser().parse(mirrorRaw, { botId: mirror.botId });
  };
  return { candidate, mirror, mirrorRaw, metadata, inspect, reparse };
}

describe('exact source diagnostic for legacy semantic mirrors', () => {
  it('accepts the already-supported delivery metadata without mutating original evidence', () => {
    const f = fixture();
    const before = legacySnapshotDigest([f.candidate, f.mirror]);
    expect(f.inspect()).toBeNull();
    expect(legacySnapshotDigest([f.candidate, f.mirror])).toBe(before);
  });

  it.each([
    ['storedRaw', 'source_raw_mismatch'],
    ['earlyReceiptClock', 'source_clock_order'],
    ['ingressClock', 'source_ingress_clock'],
    ['normalizedClock', 'source_normalized_clock'],
    ['normalizedIdentity', 'source_identity_mismatch'],
    ['normalizedText', 'source_text_mismatch'],
    ['receiptReceiver', 'source_receiver_unproved'],
    ['catalog', 'receiver_catalog_unproved'],
    ['storedSemantic', 'stored_semantic_mismatch'],
    ['rebuiltSemantic', 'rebuilt_semantic_mismatch'],
    ['scope', 'scope_mismatch'],
    ['content', 'content_mismatch'],
    ['command', 'source_command'],
    ['unknownNestedTarget', 'source_attachments'],
  ])('reports the deciding guard for %s without revealing values', (fault, expected) => {
    const f = fixture();
    if (fault === 'storedRaw') f.mirror.rawPayload = { private: 'private-raw' };
    if (fault === 'earlyReceiptClock') f.mirror.createdAt = new Date(f.mirrorRaw.timestamp - 1);
    if (fault === 'ingressClock') f.mirror.normalizedPayload.eventTimestampSource = 'ingress';
    if (fault === 'normalizedClock')
      f.mirror.normalizedPayload.message!.createdAt = '2026-01-01T00:00:00.000Z';
    if (fault === 'normalizedIdentity')
      f.mirror.normalizedPayload.message!.senderId = 'private-other-person';
    if (fault === 'normalizedText') f.mirror.normalizedPayload.message!.text = 'private-other-text';
    if (fault === 'receiptReceiver') f.mirror.botId = 'private-unknown-receiver';
    if (fault === 'catalog') f.metadata.bot_id = 'private-unknown-catalog';
    if (fault === 'storedSemantic') f.metadata.semantic_key = 'private-unknown-semantic';
    if (fault === 'rebuiltSemantic') {
      f.candidate.claim.semanticKey = 'private-unknown-semantic';
      f.metadata.semantic_key = f.candidate.claim.semanticKey;
    }
    if (fault === 'scope') f.candidate.source.userId = 'private-other-person';
    if (fault === 'content' || fault === 'command') {
      f.mirrorRaw.message.body.text = fault === 'command' ? '/ban' : 'Different ordinary original';
      f.reparse();
    }
    if (fault === 'unknownNestedTarget') {
      Object.assign(f.mirrorRaw.message.body.attachments[0]!.payload, {
        user_id: 'private-other-target',
      });
      f.reparse();
    }
    const result = f.inspect();
    expect(result).toBe(expected);
    expect(result).not.toMatch(/private-|https?:|token/u);
  });

  it('requires the exact mirror row before any other proof', () => {
    const f = fixture();
    expect(inspectLegacyRecoveryMirror(f.candidate as never, null, f.metadata, ['major'])).toBe(
      'row_missing',
    );
  });
});
