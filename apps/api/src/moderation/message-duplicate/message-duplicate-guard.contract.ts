import type { MessageDuplicateNoticeProof } from './message-duplicate-notice-proof';

export const MESSAGE_DUPLICATE_NOTICE_AUTHORITY = Symbol('MESSAGE_DUPLICATE_NOTICE_AUTHORITY');

export class MessageDuplicateGuardRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MessageDuplicateGuardRejectedError';
  }
}

export type MessageDuplicateNoticeAuthority = {
  assertMessageStillActionable(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string;
    botId: string;
    binding: MessageDuplicateNoticeProof['binding'];
    notice: MessageDuplicateNoticeProof;
    beforeFinalAuthority?: () => Promise<void>;
  }): Promise<'allowed' | 'absent'>;
};
