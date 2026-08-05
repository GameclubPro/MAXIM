import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import type { DuplicateDecision, DuplicateHit } from '../rule-engine.contract';
import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import type { PhotoDuplicateOrderingLease } from './photo-duplicate-ordering.store';

export const PHOTO_DUPLICATE_MODERATION_ACTIONS = Symbol('PHOTO_DUPLICATE_MODERATION_ACTIONS');

export type PhotoDuplicateModerationActionRequest = {
  update: MaxUpdate;
  chatId: string;
  userId: string;
  messageId: string;
  settings: ChatSettings;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
  actionClaimed: boolean;
  lease: PhotoDuplicateOrderingLease;
  outcome: { kind: 'hit'; hit: DuplicateHit } | { kind: 'decision'; decision: DuplicateDecision };
};

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
  executePhotoDuplicateAction(params: PhotoDuplicateModerationActionRequest): Promise<void>;
};
