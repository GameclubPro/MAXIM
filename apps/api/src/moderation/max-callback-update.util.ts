import type { MaxUpdate } from '@maxim/contracts';

export function extractMaxCallbackId(update: MaxUpdate): string | null {
  const callback = extractMaxCallbackNode(update);
  const value = callback?.callback_id ?? callback?.callbackId ?? callback?.id;
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

export function extractMaxCallbackPayloadRaw(update: MaxUpdate): string | null {
  const callback = extractMaxCallbackNode(update);
  const value = callback?.payload ?? callback?.data;
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

export function extractMaxCallbackPayload(update: MaxUpdate): string | null {
  return extractMaxCallbackPayloadRaw(update)?.toLowerCase() ?? null;
}

export function extractMaxCallbackUserId(update: MaxUpdate): string | null {
  const callback = extractMaxCallbackNode(update);
  const user = asRecord(callback?.user);
  const value = user?.user_id ?? user?.userId ?? user?.id;
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim();
  return normalized || null;
}

function extractMaxCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
  const raw = asRecord(update.raw);
  if (!raw) {
    return null;
  }

  const data = asRecord(raw.data);
  const event = asRecord(raw.event);
  const candidates = [
    asRecord(raw.callback),
    asRecord(raw.message_callback),
    asRecord(data?.callback),
    asRecord(data?.message_callback),
    asRecord(event?.callback),
    asRecord(event?.message_callback),
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
      candidate.payload !== undefined
    ) {
      return candidate;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
