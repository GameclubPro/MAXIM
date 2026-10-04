import type { MaxUpdate } from '@maxim/contracts';

const PRIVATE_FLOW_VALUE_MAX_LENGTH = 512;

export type PublisherPrivateFlowCallback = {
  payload: string;
  callbackId: string | null;
  actorUserId: string | null;
};

export function readPublisherPrivateStartPayload(update: MaxUpdate): string | null {
  if (update.type.trim().toLowerCase() !== 'bot_started') return null;
  const raw = asRecord(update.raw);
  const data = asRecord(raw?.data);
  const event = asRecord(raw?.event);
  // FLAG: Read only the declared MAX event envelopes, never arbitrary nested media.
  const nodes = [
    raw,
    data,
    event,
    asRecord(raw?.bot_started),
    asRecord(data?.bot_started),
    asRecord(event?.bot_started),
  ];
  for (const node of nodes) {
    for (const value of [node?.payload, node?.start_payload, node?.startPayload]) {
      const payload = readBoundedString(value);
      if (payload) return payload;
    }
  }
  return null;
}

export function readPublisherPrivateCallback(
  update: MaxUpdate,
): PublisherPrivateFlowCallback | null {
  if (update.type.trim().toLowerCase() !== 'message_callback') return null;
  const raw = asRecord(update.raw);
  const data = asRecord(raw?.data);
  const event = asRecord(raw?.event);
  const candidates = [
    asRecord(raw?.callback),
    asRecord(raw?.message_callback),
    asRecord(data?.callback),
    asRecord(data?.message_callback),
    asRecord(event?.callback),
    asRecord(event?.message_callback),
  ];
  for (const candidate of candidates) {
    const callback = asRecord(candidate?.callback) ?? candidate;
    if (!callback || (callback.payload === undefined && callback.data === undefined)) continue;
    const payload = readBoundedString(callback.payload ?? callback.data);
    if (!payload) return null;
    // FLAG: Actor and callback identity must come from the same envelope as its payload.
    const user = asRecord(callback.user);
    return {
      payload,
      callbackId: readBoundedString(callback.callback_id ?? callback.callbackId ?? callback.id),
      actorUserId: readBoundedString(user?.user_id ?? user?.userId ?? user?.id),
    };
  }
  return null;
}

function readBoundedString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= PRIVATE_FLOW_VALUE_MAX_LENGTH ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
