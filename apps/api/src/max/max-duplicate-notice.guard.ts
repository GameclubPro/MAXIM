import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import {
  MESSAGE_DUPLICATE_NOTICE_AUTHORITY,
  MessageDuplicateGuardRejectedError,
  type MessageDuplicateNoticeAuthority,
} from '../moderation/message-duplicate/message-duplicate-guard.contract';
import { readMessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import type { MaxActionJob } from './max-client.service';

export class MaxDuplicateNoticeRejectedError extends UnrecoverableError {
  readonly code = 'message_duplicate_notice_no_longer_authorized';
  constructor() {
    super('message_duplicate_notice_no_longer_authorized');
  }
}

export function hasMaxDuplicateNoticeProof(action: Pick<MaxActionJob, 'ledgerContext'>): boolean {
  return !!action.ledgerContext && Object.hasOwn(action.ledgerContext, 'duplicateNotice');
}

export function isMaxDuplicateNoticeAction(
  action: Pick<MaxActionJob, 'actionType' | 'ledgerContext' | 'idempotencyKey'>,
): boolean {
  // FLAG: Receipt settlement precedes this guard. Legacy unbound explanation jobs
  // may settle their receipt but cannot acquire permission for a new group SEND.
  return (
    hasMaxDuplicateNoticeProof(action) ||
    (action.actionType === 'SEND_MESSAGE' &&
      /(?:^|__)(?:message(?:_v1|-v1)|photo)-duplicate(?::|__|-).*?(?::|-|__)explanation(?:$|__)/u.test(
        action.idempotencyKey,
      ))
  );
}

@Injectable()
export class MaxDuplicateNoticeGuardService {
  constructor(private readonly modules: ModuleRef) {}

  async assertAllowed(
    action: MaxActionJob,
    selectedBotId: string,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<void> {
    if (!isMaxDuplicateNoticeAction(action)) return;
    const proof = readMessageDuplicateNoticeProof(action.ledgerContext?.duplicateNotice);
    if (
      !proof ||
      action.actionType !== 'SEND_MESSAGE' ||
      action.chatId !== proof.chatId ||
      !selectedBotId.trim() ||
      Date.now() >= proof.deadlineAtMs
    )
      throw new MaxDuplicateNoticeRejectedError();
    // FLAG: Resolve the independent token only at dispatch. Importing the DELETE
    // implementation here would cycle through its MaxClient dependency at startup.
    const guard = this.modules.get<MessageDuplicateNoticeAuthority>(
      MESSAGE_DUPLICATE_NOTICE_AUTHORITY,
      { strict: false },
    );
    try {
      if (
        (await guard.assertMessageStillActionable({
          chatId: proof.chatId,
          messageId: proof.binding.messageId,
          subjectUserId: proof.binding.senderId,
          botId: selectedBotId,
          binding: proof.binding,
          notice: proof,
          beforeFinalAuthority,
        })) !== 'allowed' ||
        Date.now() >= proof.deadlineAtMs
      )
        throw new MaxDuplicateNoticeRejectedError();
    } catch (error) {
      if (error instanceof MessageDuplicateGuardRejectedError)
        throw new MaxDuplicateNoticeRejectedError();
      throw error;
    }
  }
}
