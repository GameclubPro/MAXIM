import { NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES } from './night-mode-transition-notice-persistence-error';

type ProtectedModerationEventSnapshot = {
  id: string;
  ruleCode: string;
};

type ProtectedModerationEventFindFirstArgs = {
  where: {
    chatId: string;
    OR: [
      {
        messageId: string;
        ruleCode: { in: string[] };
      },
      {
        ruleCode: 'GREETING_MESSAGE';
        metadata: {
          path: ['sentMessageId'];
          equals: string;
        };
      },
    ];
  };
  select: {
    id: true;
    ruleCode: true;
  };
};

export type ProtectedModerationEventReader = {
  findFirst?: (
    args: ProtectedModerationEventFindFirstArgs,
  ) =>
    | PromiseLike<ProtectedModerationEventSnapshot | null>
    | ProtectedModerationEventSnapshot
    | null
    | undefined;
};

export async function classify(
  reader: ProtectedModerationEventReader | null | undefined,
  params: { chatId: string; messageId: string },
): Promise<'night_mode_notice' | 'greeting_message' | null> {
  const event = await reader?.findFirst?.({
    where: {
      chatId: params.chatId,
      OR: [
        {
          messageId: params.messageId,
          ruleCode: { in: [...NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES] },
        },
        {
          ruleCode: 'GREETING_MESSAGE',
          metadata: {
            path: ['sentMessageId'],
            equals: params.messageId,
          },
        },
      ],
    },
    select: {
      id: true,
      ruleCode: true,
    },
  });

  if (!event) {
    return null;
  }
  return event.ruleCode === 'GREETING_MESSAGE' ? 'greeting_message' : 'night_mode_notice';
}
