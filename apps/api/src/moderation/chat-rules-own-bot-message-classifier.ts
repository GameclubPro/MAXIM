import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';

const CHAT_RULES_PUBLISH_FENCE_RETRY_MAX_MS = 15_000;

type ChatRulesPublicationSnapshot = {
  publishedMessageId: string | null;
  publishSendStartedAt: Date | null;
};

type ChatRulesPublicationFindUniqueArgs = {
  where: { chatId: string };
  select: {
    publishedMessageId: true;
    publishSendStartedAt: true;
  };
};

export type ChatRulesPublicationReader = {
  findUnique?: (
    args: ChatRulesPublicationFindUniqueArgs,
  ) =>
    | PromiseLike<ChatRulesPublicationSnapshot | null>
    | ChatRulesPublicationSnapshot
    | null
    | undefined;
};

export class ChatRulesPublishFenceRetryError extends Error {
  readonly chatRulesPublishFenceRetryable = true;

  constructor(readonly retryAfterMs: number) {
    super('Chat rules publication is in flight; retry own-bot message classification');
    this.name = 'ChatRulesPublishFenceRetryError';
  }
}

export async function classify(
  reader: ChatRulesPublicationReader | null | undefined,
  params: { chatId: string; messageId: string },
  now: () => number = Date.now,
): Promise<'published_chat_rules' | null> {
  const publication = await reader?.findUnique?.({
    where: { chatId: params.chatId },
    select: {
      publishedMessageId: true,
      publishSendStartedAt: true,
    },
  });

  if (publication?.publishedMessageId?.trim() === params.messageId.trim()) {
    return 'published_chat_rules';
  }

  if (publication?.publishSendStartedAt) {
    const fenceAgeMs = now() - publication.publishSendStartedAt.getTime();
    if (fenceAgeMs >= 0 && fenceAgeMs < MAX_SEND_FENCE_STALE_MS) {
      const fenceRemainingMs = Math.ceil(MAX_SEND_FENCE_STALE_MS - fenceAgeMs);
      throw new ChatRulesPublishFenceRetryError(
        Math.max(1, Math.min(CHAT_RULES_PUBLISH_FENCE_RETRY_MAX_MS, fenceRemainingMs)),
      );
    }
  }

  return null;
}

export function isRetryable(error: unknown): error is ChatRulesPublishFenceRetryError {
  return error instanceof ChatRulesPublishFenceRetryError;
}
