type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordLike) : null;
}

function readString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}

function parseTimestampMs(value: unknown): number | null {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Date.parse(value)
          : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.trunc(parsed < 10_000_000_000 ? parsed * 1_000 : parsed);
}

function normalizeTimestampIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function readMessage(payload: RecordLike): RecordLike | null {
  return asRecord(payload.message) ?? asRecord(asRecord(payload.raw)?.message);
}

function readCallback(payload: RecordLike): RecordLike | null {
  const data = asRecord(payload.data);
  const event = asRecord(payload.event);
  const raw = asRecord(payload.raw);
  const rawData = raw ? asRecord(raw.data) : null;
  const rawEvent = raw ? asRecord(raw.event) : null;
  const candidates = [
    asRecord(payload.callback),
    asRecord(payload.message_callback),
    data ? asRecord(data.callback) : null,
    data ? asRecord(data.message_callback) : null,
    event ? asRecord(event.callback) : null,
    event ? asRecord(event.message_callback) : null,
    raw ? asRecord(raw.callback) : null,
    raw ? asRecord(raw.message_callback) : null,
    rawData ? asRecord(rawData.callback) : null,
    rawData ? asRecord(rawData.message_callback) : null,
    rawEvent ? asRecord(rawEvent.callback) : null,
    rawEvent ? asRecord(rawEvent.message_callback) : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const nested = asRecord(candidate.callback);
    if (nested) {
      return nested;
    }

    if (
      candidate.callback_id !== undefined ||
      candidate.callbackId !== undefined ||
      candidate.id !== undefined
    ) {
      return candidate;
    }
  }

  return null;
}

function readUser(payload: RecordLike): RecordLike | null {
  const data = asRecord(payload.data);
  const event = asRecord(payload.event);
  const raw = asRecord(payload.raw);
  const rawData = raw ? asRecord(raw.data) : null;
  const rawEvent = raw ? asRecord(raw.event) : null;
  const candidates = [
    asRecord(payload.user),
    asRecord(payload.member),
    asRecord(payload.sender),
    data ? asRecord(data.user) : null,
    data ? asRecord(data.member) : null,
    event ? asRecord(event.user) : null,
    event ? asRecord(event.member) : null,
    raw ? asRecord(raw.user) : null,
    raw ? asRecord(raw.member) : null,
    raw ? asRecord(raw.sender) : null,
    rawData ? asRecord(rawData.user) : null,
    rawData ? asRecord(rawData.member) : null,
    rawEvent ? asRecord(rawEvent.user) : null,
    rawEvent ? asRecord(rawEvent.member) : null,
  ];
  return candidates.find((candidate) => candidate !== null) ?? null;
}

function readChatId(payload: RecordLike): string | null {
  const message = readMessage(payload);
  const user = readUser(payload);
  const callback = readCallback(payload);
  const raw = asRecord(payload.raw);
  return (
    readString(message?.chatId) ??
    readString(message?.chat_id) ??
    readString(payload.chatId) ??
    readString(payload.chat_id) ??
    readString(raw?.chatId) ??
    readString(raw?.chat_id) ??
    readString(user?.chatId) ??
    readString(user?.chat_id) ??
    readString(callback?.chatId) ??
    readString(callback?.chat_id) ??
    null
  );
}

function readMessageId(payload: RecordLike): string | null {
  const message = readMessage(payload);
  const raw = asRecord(payload.raw);
  return (
    readString(message?.messageId) ??
    readString(message?.message_id) ??
    readString(payload.messageId) ??
    readString(payload.message_id) ??
    readString(raw?.messageId) ??
    readString(raw?.message_id) ??
    null
  );
}

function readCallbackId(payload: RecordLike): string | null {
  const callback = readCallback(payload);
  const raw = asRecord(payload.raw);
  return (
    readString(callback?.callback_id) ??
    readString(callback?.callbackId) ??
    readString(callback?.id) ??
    readString(payload.callback_id) ??
    readString(payload.callbackId) ??
    readString(raw?.callback_id) ??
    readString(raw?.callbackId) ??
    null
  );
}

function readMembershipUserIds(payload: RecordLike): string[] {
  const membership = asRecord(payload.membership);
  const user = readUser(payload);
  const message = readMessage(payload);
  const rawMemberUserIds = Array.isArray(membership?.memberUserIds)
    ? membership?.memberUserIds
    : Array.isArray(membership?.member_user_ids)
      ? membership?.member_user_ids
      : [];
  const userIds = new Set<string>();
  for (const value of rawMemberUserIds) {
    const userId = readString(value);
    if (userId) {
      userIds.add(userId);
    }
  }

  const directUserIds = [
    user?.user_id,
    user?.userId,
    user?.id,
    message?.senderId,
    message?.sender_id,
    payload.user_id,
    payload.userId,
  ];
  for (const value of directUserIds) {
    const userId = readString(value);
    if (userId) {
      userIds.add(userId);
    }
  }

  return [...userIds].sort();
}

function resolveMembershipEventType(payload: RecordLike, updateType: string): string | null {
  if (
    updateType === 'user_added' ||
    updateType === 'bot_added' ||
    updateType === 'user_removed' ||
    updateType === 'bot_removed'
  ) {
    return updateType;
  }

  if (updateType !== 'message_created') {
    return null;
  }

  const membership = asRecord(payload.membership);
  const action = readLowerString(membership?.action);
  if (action === 'added') {
    return 'user_added';
  }
  if (action === 'removed') {
    return 'user_removed';
  }
  return null;
}

function readEventTimestampIso(payload: RecordLike): string | null {
  const message = readMessage(payload);
  const data = asRecord(payload.data);
  const event = asRecord(payload.event);
  const raw = asRecord(payload.raw);
  const rawData = raw ? asRecord(raw.data) : null;
  const rawEvent = raw ? asRecord(raw.event) : null;
  const candidates = [
    payload.timestamp,
    payload.created_at,
    payload.createdAt,
    data?.timestamp,
    data?.created_at,
    data?.createdAt,
    event?.timestamp,
    event?.created_at,
    event?.createdAt,
    raw?.timestamp,
    raw?.created_at,
    raw?.createdAt,
    rawData?.timestamp,
    rawData?.created_at,
    rawData?.createdAt,
    rawEvent?.timestamp,
    rawEvent?.created_at,
    rawEvent?.createdAt,
    message?.createdAt,
    message?.created_at,
    message?.timestamp,
  ];
  for (const candidate of candidates) {
    const timestampMs = parseTimestampMs(candidate);
    if (timestampMs !== null) {
      return normalizeTimestampIso(timestampMs);
    }
  }
  return null;
}

export function readWebhookEventTimestamp(payload: unknown): Date | null {
  const row = asRecord(payload);
  if (!row) {
    return null;
  }
  if (readLowerString(row.eventTimestampSource) === 'ingress') {
    return null;
  }

  const timestampIso = readEventTimestampIso(row);
  return timestampIso ? new Date(timestampIso) : null;
}

export function buildWebhookSemanticEventKey(payload: unknown): string | null {
  const row = asRecord(payload);
  if (!row) {
    return null;
  }

  const updateType = readLowerString(row.type ?? row.update_type ?? row.event_type);
  if (!updateType) {
    return null;
  }
  const hasTrustedEventTimestamp = readLowerString(row.eventTimestampSource) !== 'ingress';

  const chatId = readChatId(row);
  const messageId = readMessageId(row);
  if (chatId && messageId && updateType === 'message_created') {
    return `message:${updateType}:${chatId}:${messageId}`;
  }

  if (chatId && messageId && updateType === 'message_edited') {
    const eventAtIso = hasTrustedEventTimestamp ? readEventTimestampIso(row) : null;
    return eventAtIso ? `message:${updateType}:${chatId}:${messageId}:${eventAtIso}` : null;
  }

  if (updateType === 'chat_title_changed') {
    const chatTitle = readString(readMessage(row)?.chatTitle);
    const eventAtIso = hasTrustedEventTimestamp ? readEventTimestampIso(row) : null;
    return chatId && chatTitle && eventAtIso
      ? `chat-title:${chatId}:${eventAtIso}:${chatTitle}`
      : null;
  }

  const callbackId = readCallbackId(row);
  if (callbackId && updateType === 'message_callback') {
    return `callback:${chatId ?? ''}:${callbackId}`;
  }

  if ((updateType === 'bot_stopped' || updateType === 'dialog_removed') && chatId) {
    const affectedBotId = readString(row.botId ?? row.bot_id);
    const eventAtIso = hasTrustedEventTimestamp ? readEventTimestampIso(row) : null;
    if (affectedBotId && eventAtIso) {
      return `bot-lifecycle:${updateType}:${chatId}:${affectedBotId}:${eventAtIso}`;
    }
  }

  const membershipEventType = resolveMembershipEventType(row, updateType);
  if (membershipEventType && chatId) {
    const userIds = readMembershipUserIds(row);
    const eventAtIso = hasTrustedEventTimestamp ? readEventTimestampIso(row) : null;
    if (userIds.length > 0 && eventAtIso) {
      return `membership:${membershipEventType}:${chatId}:${userIds.join(',')}:${eventAtIso}`;
    }
  }

  if (chatId && messageId) {
    return `message:${updateType}:${chatId}:${messageId}`;
  }

  return null;
}
