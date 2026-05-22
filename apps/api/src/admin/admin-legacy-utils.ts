import type {
  ChannelOverview,
  ChannelSettings,
  ChatParticipantsQuery,
  LogsDashboardRange,
  ManagedEntityType,
  MembershipActivityQuery,
  ModerationFeedQuery,
} from '@maxim/contracts';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';

export function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeAppBaseUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/\/+$/, '');
  if (!normalized || !/^https?:\/\//iu.test(normalized)) {
    return null;
  }

  return normalized;
}

export function normalizeOwnBotUserId(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeBotContactId(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) {
    return null;
  }

  return normalized;
}

export async function mapWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results: R[] = new Array<R>(items.length);
  let currentIndex = 0;

  const runWorker = async () => {
    while (true) {
      const itemIndex = currentIndex;
      currentIndex += 1;

      if (itemIndex >= items.length) {
        return;
      }

      results[itemIndex] = await worker(items[itemIndex]);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  return results;
}

export function isFallbackTitle(chatId: string, title: string): boolean {
  const normalized = title.trim();
  return normalized === `Chat ${chatId}` || normalized === `Channel ${chatId}`;
}

export function resolvePresentableManagedEntityTitle(
  chatId: string,
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const normalized = readTrimmedString(candidate);
    if (!normalized || normalized === chatId || isFallbackTitle(chatId, normalized)) {
      continue;
    }

    return normalized;
  }

  return null;
}

export function isPrismaKnownError(error: unknown, code: string): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === code;
  }

  return (error as { code?: string } | null)?.code === code;
}

export function extractMaxErrorStatus(error: unknown): number | null {
  const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

export function extractMaxErrorCode(error: unknown): string | null {
  const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  return typeof maybeCode === 'string' && maybeCode.trim() ? maybeCode.trim().toLowerCase() : null;
}

export function extractMaxErrorMessage(error: unknown): string {
  const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response?.data
    ?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage.trim().toLowerCase();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().toLowerCase();
  }

  return String(error).trim().toLowerCase();
}

export function isPrivateDialogChatUnavailableError(error: unknown): boolean {
  const status = extractMaxErrorStatus(error);
  if (status === 404) {
    return true;
  }

  if (status !== 403) {
    return false;
  }

  const code = extractMaxErrorCode(error);
  if (code === 'chat.denied' || code === 'chat.not.found') {
    return true;
  }

  const message = extractMaxErrorMessage(error);
  return (
    message.includes('chat not found') ||
    message.includes('not accessible') ||
    message.includes('bot is not a chat member') ||
    message.includes('forbidden')
  );
}

export function isBotAdminLookupDeniedError(error: unknown): boolean {
  const status = extractMaxErrorStatus(error);
  const code = extractMaxErrorCode(error);
  if (code === 'chat.denied' || code === 'chat.not.found') {
    return true;
  }

  if (status !== 400 && status !== 403) {
    return false;
  }

  const message = extractMaxErrorMessage(error);
  return (
    message.includes('method is available only for chat administrator') ||
    message.includes('bot is not a chat member') ||
    message.includes('not accessible') ||
    message.includes('chat not found')
  );
}

export function isMaxApiThrottleError(error: unknown): boolean {
  const status = extractMaxErrorStatus(error);
  if (status === 429) {
    return true;
  }

  const message = extractMaxErrorMessage(error);
  return message.includes('rate limit exceeded') || message.includes('circuit breaker');
}

export function isMaxApiTimeoutError(error: unknown): boolean {
  if (isPrismaKnownError(error, 'P2024')) {
    return false;
  }

  const maybeCode = (error as { code?: unknown }).code;
  if (typeof maybeCode === 'string' && maybeCode.trim().toUpperCase() === 'ECONNABORTED') {
    return true;
  }

  const message = extractMaxErrorMessage(error);
  return message.includes('timeout');
}

export function parseChatIdAsBigInt(chatId: string): bigint | null {
  if (typeof chatId !== 'string') {
    return null;
  }

  const normalized = chatId.trim();
  if (!/^-?\d+$/u.test(normalized)) {
    return null;
  }

  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

export function isPrivateDirectChat(chatId: string): boolean {
  const numericChatId = parseChatIdAsBigInt(chatId);
  return numericChatId !== null && numericChatId > 0n;
}

export function isUnsupportedManagedChat(chatId: string, entityType: ManagedEntityType): boolean {
  return entityType === 'chat' && isPrivateDirectChat(chatId);
}

export function buildLogsDashboardResponseCacheKey(
  chatId: string,
  userId: string,
  range: LogsDashboardRange,
  includeActivityPreview: boolean,
  includeModerationPreview: boolean,
): string {
  void userId;
  return `${chatId}:${range}:activity=${includeActivityPreview ? 1 : 0}:moderation=${
    includeModerationPreview ? 1 : 0
  }`;
}

export function buildModerationFeedPageCacheKey(
  chatId: string,
  userId: string,
  entityType: ManagedEntityType,
  query: ModerationFeedQuery,
  profileOptions: { allowRemoteLookup?: boolean } = {},
): string {
  void userId;
  const profileMode = profileOptions.allowRemoteLookup === false ? 'local' : 'remote';
  return [
    chatId,
    entityType,
    query.range,
    query.filter,
    String(query.limit),
    query.cursor ?? '',
    profileMode,
  ].join(':');
}

export function buildMembershipActivityFeedPageCacheKey(
  chatId: string,
  userId: string,
  entityType: ManagedEntityType,
  query: MembershipActivityQuery,
  profileOptions: { allowRemoteLookup?: boolean } = {},
): string {
  void userId;
  const profileMode = profileOptions.allowRemoteLookup === false ? 'local' : 'remote';
  return [
    chatId,
    entityType,
    query.range,
    query.filter,
    String(query.limit),
    query.cursor ?? '',
    profileMode,
  ].join(':');
}

export function buildChatParticipantsPageCacheKey(
  chatId: string,
  userId: string,
  entityType: ManagedEntityType,
  query: ChatParticipantsQuery,
): string {
  return [
    chatId,
    userId,
    entityType,
    query.range,
    String(query.limit),
    query.cursor ?? '',
    query.search ?? '',
  ].join(':');
}

export function buildResolvedUserProfileCacheKey(
  chatId: string,
  entityType: ManagedEntityType,
  userId: string,
  options: { allowRemoteLookup?: boolean } = {},
): string {
  return [
    chatId,
    entityType,
    userId,
    options.allowRemoteLookup === false ? 'local' : 'remote',
  ].join(':');
}

export function toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
  return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
}

export function fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
  return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
}

export function buildChannelOverview(
  settings: Pick<
    ChannelSettings,
    'commentsEnabled' | 'postSuggestionsEnabled' | 'commentsModerationEnabled'
  >,
): ChannelOverview {
  const enabledScenariosCount =
    Number(settings.commentsEnabled) + Number(settings.postSuggestionsEnabled);

  return {
    enabledScenariosCount,
    commentsEnabled: settings.commentsEnabled,
    postSuggestionsEnabled: settings.postSuggestionsEnabled,
    commentsModerationEnabled: settings.commentsEnabled && settings.commentsModerationEnabled,
  };
}
