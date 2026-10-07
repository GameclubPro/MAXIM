import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

// FLAG: This closure excludes one validated outer human source and exact children.
// It never grants participant immunity or proves earlier remote outcomes. Every
// producer below must retain a final exact-source check when regenerating work.
export const SOURCE_ABANDONMENT_SOURCE_CLOSURE = Object.freeze({
  version: 2,
  source: 'outer-human-text-with-strict-share-preview-or-flat-forward-or-reply-major-group-message',
  forward: {
    validator: 'inspectLegacyForwardText',
    content: 'parser-proved-text-and-zero-through-ten-strict-image-photo-attachments',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
    linkedIdentity: 'content-provenance-never-held-message-person-or-mutation-target',
  },
  share: {
    validator: 'isSourceAbandonmentDirectMedia',
    content: 'one-official-https-share-preview-with-bounded-passive-metadata-and-no-linked-message',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
  },
  markup: 'bounded-passive-formatting-or-strict-https-link-with-original-utf16-text-bounds',
  reply: {
    validator: 'inspectSourceAbandonmentReplyText',
    content: 'parser-proved-outer-text-and-flat-quoted-text-with-zero-through-ten-strict-images',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
    linkedIdentity: 'quoted-metadata-never-held-message-person-or-mutation-target',
  },
  excluded: [
    'commands-and-configured-triggers',
    'private-channel-callback-membership',
    'direct-images-video-mixed-share-media-nested-links-and-unknown-content-shapes',
    'unknown-or-secondary-source',
  ],
  guards: {
    canonical: 'positive-exact-source-receipt-proof-before-order-release',
    moderation: 'exact-message-before-evidence-immunity-and-final-effect',
    deleteIntent: 'exact-chat-message-before-dispatch-with-confirmed-receipt-first',
    ruleFollowup: 'exact-source-before-sanction-and-notice-handoff',
    maxAction: 'every-exact-source-envelope-and-immutable-child-key-before-effect',
    sourceRegeneration: 'source-hold-before-new-evidence-or-child-production',
    spammerObservation: 'exact-source-and-exact-observation-child-before-denormalization',
    duplicateReference: 'current-and-original-source-holds-before-qualification-and-effect',
    photoContinuation:
      'held-current-before-native-work-and-baseline-held-reference-before-counter-claim-or-effect',
    ocrContinuation:
      'held-outer-receipt-before-owner-rebind-source-read-native-work-or-technical-review',
    automaticReplies: 'original-message-before-send-and-replacement-delete',
    retentionAndCleanup:
      'attributed-send-cleanup-checks-original-source-and-immutable-parent-child',
    unattributedCleanup:
      'partial-markers-refused-null-original-requires-exact-completed-major-moderation-send-and-same-chat-producer-proof',
  },
  history: 'retain-intent-action-sanction-claim-and-ambiguous-member-fences-without-replay',
  independence: 'distinct-message-same-user-is-outside-source-exclusion',
  // FLAG: A separate authenticated bot-message receipt and current cleanup policy
  // own BOT_MESSAGE_AUTO_DELETE authority for that bot message. They do not consume
  // the abandoned human claim; explicit sendAutoDelete still consumes parent SEND authority.
  independentBotMessagePolicy:
    'authenticated-own-bot-message-receipt-current-policy-exact-message-claim-origin-only-routing',
});

export function sourceAbandonmentSourceClosureDigest(sourceSha: string, imageId: string): string {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha) || !/^sha256:[0-9a-f]{64}$/u.test(imageId))
    throw new Error('Invalid source closure identity');
  return sourceAbandonmentDigest({
    sourceSha,
    imageId,
    closure: SOURCE_ABANDONMENT_SOURCE_CLOSURE,
  });
}
