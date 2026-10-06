import { legacyRecoveryLiveDigest } from './legacy-recovery-live-protocol';

// FLAG: This is a reviewed source-class closure, not a claim of absent history.
// The host must attest this exact source/image and stop every old producer before
// installation. Preserve unknown receipts and install all permanent scope holds.
// Widening the source class or changing a descendant requires a new closure review.
export const LEGACY_RECOVERY_SOURCE_CLOSURE = Object.freeze({
  version: 3,
  source: 'original-human-text-direct-photos-or-videos-or-flat-forwarded-photos-major-chat',
  excluded: Object.freeze([
    'command',
    'private',
    'channel',
    'membership',
    'callback',
    'non-image-or-video-direct-media',
    'non-image-forward-media',
    'reply',
    'nested-or-unknown-forward',
    'secondary-subject-command-or-seller-trigger',
  ]),
  guards: Object.freeze({
    ingressAndCanonical: 'sealed-exact-receipt-disposition-before-preparation-or-execution',
    automaticModeration: 'message-and-global-user-before-evidence-immunity-and-mutation',
    queuedMax: 'message-global-user-original-source-preseal-chat-send-and-parent-autodelete',
    ruleFollowup: 'source-message-and-user-before-sanction-and-notice-handoff',
    duplicateAndOcr: 'held-receipt-terminal-and-final-delete-source-guards',
    duplicateImageReference:
      'current-and-original-source-holds-before-qualification-immunity-and-final-effect',
    legacyPhoto: 'retired-worker-and-legacy-photo-only-delete-authority-refused',
    retention: 'source-author-before-capture-and-final-delete',
    globalSpammer: 'global-user-before-reputation-and-enforcement',
    automaticChatComment: 'original-source-before-send-fence-and-replacement-delete',
    publisherAutoReply: 'transport-final-reply-link-to-original-message',
    ownBotCleanup: 'original-max-message-clock-or-unknown-before-producer-and-final-delete',
  }),
  independentTriggers: Object.freeze([
    'explicit-publication-and-import',
    'private-authoring',
    'authenticated-admin-operation',
    'night-boundary-and-membership-event',
  ]),
});

export function legacyRecoverySourceClosureDigest(sourceSha: string, imageId: string): string {
  if (!/^[0-9a-f]{40}$/u.test(sourceSha) || !/^sha256:[0-9a-f]{64}$/u.test(imageId))
    throw new Error('Invalid source closure runtime identity');
  return legacyRecoveryLiveDigest({ sourceSha, imageId, closure: LEGACY_RECOVERY_SOURCE_CLOSURE });
}
