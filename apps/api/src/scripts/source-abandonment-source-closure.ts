import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

// FLAG: This closure excludes one validated original source and exact children.
// It never grants participant immunity or proves earlier remote outcomes. Every
// producer below must retain a final exact-source check when regenerating work.
export const SOURCE_ABANDONMENT_SOURCE_CLOSURE = Object.freeze({
  version: 6,
  source:
    'validated-human-chat-or-explicit-authorless-channel-exact-original-message-created-or-edited',
  directMedia: {
    validator: 'isLegacyDirectMedia-without-linked-message',
    content:
      'zero-through-ten-strict-image-photo-video-attachments-or-one-strict-audio-with-passive-metadata',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
  },
  forward: {
    validator: 'inspectSourceAbandonmentForwardText',
    content:
      'parser-proved-flat-text-with-zero-through-ten-images-or-one-video-or-one-official-share',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
    linkedIdentity: 'content-provenance-never-held-message-person-or-mutation-target',
    linkedSender: 'absent-or-strict-passive-sender-never-inferred-from-outer-human',
  },
  share: {
    validator: 'isSourceAbandonmentDirectMedia',
    content: 'one-official-https-share-preview-with-bounded-passive-metadata-and-no-linked-message',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
  },
  markup:
    'bounded-passive-formatting-strict-https-link-or-positive-numeric-user-mention-with-original-utf16-bounds-including-identical-linked-markup-on-empty-forward',
  channel: {
    profile: 'CHANNEL_AUTHORLESS_V1',
    validator: 'inspectChannelAuthorlessSource',
    author: 'positive-absence-in-original-and-parser-output-real-null-never-inferred',
    scope: 'original-recipient-channel-body-mid-only',
    marker:
      'exact-channel-auto-post-marker-snapshot-child-and-permanent-sql-update-delete-insert-guard',
    independentClaims: 'exact-source-family-refuses-any-second-unfinished-execution',
    passiveMetadata:
      'strict-original-https-message-url-and-bounded-schemeless-relative-direct-markup-never-identity-or-network-authority',
    keyboard:
      'one-passive-inline-keyboard-with-bounded-official-https-link-or-open-app-buttons-and-strict-direct-image-photo-video-media',
    retainedRaw:
      'owner-exact-retained-original-receipts-exact-sampled-object-or-empty-ingress-sentinel-with-unchanged-strict-normalized-original-provenance',
  },
  reply: {
    validator: 'inspectSourceAbandonmentReplyText',
    content:
      'parser-proved-nonempty-outer-text-and-flat-quoted-text-with-zero-through-ten-images-or-one-video-or-one-official-sticker',
    scope: 'outer-recipient-chat-body-mid-sender-user-only',
    linkedIdentity: 'quoted-metadata-never-held-message-person-or-mutation-target',
  },
  excluded: [
    'commands-and-configured-triggers',
    'private-callback-membership-and-channels-outside-explicit-authorless-profile',
    'unknown-direct-media-mixed-share-media-nested-links-and-unknown-content-shapes',
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
    managedHandshakeCleanup:
      'exact-completed-major-or-separate-attested-publisher-start-send-no-context-or-reply-and-disjoint-from-every-selected-chat',
  },
  checkpoint:
    'null-or-exact-current-version-execution-waiting-bound-to-owner-semantic-immutable-deadline-and-predeadline-business-start-retained-without-replay',
  receiptSemantics:
    'exact-original-canonical-key-or-separate-attested-publisher-receipt-key-with-both-canonical-and-independent-namespace-claims-proved-without-renaming',
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
