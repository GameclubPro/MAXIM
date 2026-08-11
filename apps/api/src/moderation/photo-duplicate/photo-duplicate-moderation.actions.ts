import type { MaxUpdate } from '@maxim/contracts';
import { createHash } from 'node:crypto';
import type { ChatSettings } from '../../prisma/prisma-client';
import type { DuplicateDecision, DuplicateHit } from '../rule-engine.contract';
import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import type { PhotoHistoryViolationActionBinding } from './photo-duplicate-history.store';
import type { PhotoDuplicateOrderingLease } from './photo-duplicate-ordering.store';

export const PHOTO_DUPLICATE_MODERATION_ACTIONS = Symbol('PHOTO_DUPLICATE_MODERATION_ACTIONS');
export const PHOTO_DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE = 'DUPLICATE_MESSAGE_ACTION';
export const PHOTO_DUPLICATE_ACTION_CLAIM_DEDUPE_PREFIX = 'photo-duplicate-action:v2:';

export type ActionablePhotoDuplicateBinding = PhotoHistoryViolationActionBinding & {
  intendedAction: Exclude<PhotoHistoryViolationActionBinding['intendedAction'], 'NONE'>;
};

export type PhotoDuplicateActionClaimResult = 'claimed' | 'resumed' | 'blocked';

type PhotoDuplicateModerationActionRequestBase = {
  update: MaxUpdate;
  chatId: string;
  userId: string;
  messageId: string;
  settings: ChatSettings;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
  actionClaimed: boolean;
  lease: PhotoDuplicateOrderingLease;
  authorizeDelete: () => Promise<boolean>;
};

export type PhotoDuplicateModerationActionRequest =
  | (PhotoDuplicateModerationActionRequestBase & {
      outcome: { kind: 'hit'; hit: DuplicateHit };
      authorizeSanction?: never;
    })
  | (PhotoDuplicateModerationActionRequestBase & {
      outcome: { kind: 'decision'; decision: DuplicateDecision };
      authorizeSanction: () => Promise<boolean>;
    });

export type PhotoDuplicateModerationActions = {
  isPhotoDuplicateMessageAuthorImmune(params: {
    update: MaxUpdate;
    album: LogicalPhotoAlbum;
  }): boolean;
  consumePhotoDuplicateParticipantImmunity(params: {
    chatId: string;
    userId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean>;
  claimPhotoDuplicateAction(params: {
    chatId: string;
    userId: string;
    messageId: string;
    actionBinding: ActionablePhotoDuplicateBinding;
  }): Promise<PhotoDuplicateActionClaimResult>;
  executePhotoDuplicateAction(params: PhotoDuplicateModerationActionRequest): Promise<void>;
};

export function buildPhotoDuplicateActionClaimDedupeKey(params: {
  chatId: string;
  userId: string;
  messageId: string;
  actionBinding: ActionablePhotoDuplicateBinding;
}): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        params.chatId,
        params.userId,
        params.messageId,
        params.actionBinding.intendedAction,
        params.actionBinding.configDigest,
      ]),
    )
    .digest('hex');
  return `${PHOTO_DUPLICATE_ACTION_CLAIM_DEDUPE_PREFIX}${digest}`;
}
