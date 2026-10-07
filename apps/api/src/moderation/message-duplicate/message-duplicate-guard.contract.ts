import type { MessageDuplicateNoticeProof } from './message-duplicate-notice-proof';

export const MESSAGE_DUPLICATE_NOTICE_AUTHORITY = Symbol('MESSAGE_DUPLICATE_NOTICE_AUTHORITY');

export class MessageDuplicateGuardRejectedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MessageDuplicateGuardRejectedError';
  }
}

// FLAG: This is unavailable evidence during initial qualification, never terminal delete authority.
export class MessageDuplicateQualificationSourceUnavailableError extends Error {
  readonly code = 'message_duplicate_qualification_source_unavailable';

  constructor(
    readonly source: 'current' | 'original',
    cause: unknown,
  ) {
    super('Message duplicate qualification source unavailable', { cause });
    this.name = 'MessageDuplicateQualificationSourceUnavailableError';
  }
}

// FLAG: This read failure can end only the initial inline action after its durable
// intent owner commits a retry. It proves neither absence nor completed effects.
export class MessageDuplicateInitialSourceUnavailableError extends Error {
  readonly code = 'message_duplicate_initial_source_unavailable';

  constructor(
    readonly source: 'current' | 'original',
    cause: unknown,
  ) {
    super('Initial duplicate delete source unavailable', { cause });
    this.name = 'MessageDuplicateInitialSourceUnavailableError';
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
