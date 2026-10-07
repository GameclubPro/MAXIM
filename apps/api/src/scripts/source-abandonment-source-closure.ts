import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';

// FLAG: This closure excludes one original human text source and exact children.
// It never grants participant immunity or proves earlier remote outcomes. Every
// producer below must retain a final exact-source check when regenerating work.
export const SOURCE_ABANDONMENT_SOURCE_CLOSURE = Object.freeze({
  version: 1,
  source: 'original-human-plain-text-major-group-message',
  excluded: [
    'commands-and-configured-triggers',
    'private-channel-callback-membership',
    'attachments-replies-forwards',
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
    automaticReplies: 'original-message-before-send-and-replacement-delete',
    retentionAndCleanup:
      'attributed-send-cleanup-checks-original-source-and-immutable-parent-child',
    unattributedCleanup: 'collector-refuses-partial-sendAutoDelete-original-source-markers',
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
