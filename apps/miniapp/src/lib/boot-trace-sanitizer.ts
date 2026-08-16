import {
  isSensitiveMiniappBootTraceKey,
  MINIAPP_BOOT_TRACE_REDACTED,
  sanitizeMiniappBootTraceText,
} from './boot-trace-text-sanitizer';

export type MiniappBootTraceDetails = Record<string, unknown>;

const MAX_DETAILS_JSON_LENGTH = 1_500;
const MAX_ROUTE_LENGTH = 320;

function isDialogTokenKey(key: string): boolean {
  return key.trim().toLowerCase() === 't';
}

function isChannelDialogLaunchPayload(value: object): boolean {
  const payload = value as MiniappBootTraceDetails;
  return payload.k === 'channel-dialog' || payload.k === 'chat-dialog';
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeMiniappBootTraceText(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 12).map(sanitizeValue);
  }

  if (typeof value === 'object' && value !== null) {
    const sanitized: MiniappBootTraceDetails = {};
    const redactDialogPayloadToken = isChannelDialogLaunchPayload(value);
    for (const [key, entryValue] of Object.entries(value).slice(0, 16)) {
      sanitized[key] =
        isSensitiveMiniappBootTraceKey(key) || (redactDialogPayloadToken && isDialogTokenKey(key))
          ? MINIAPP_BOOT_TRACE_REDACTED
          : sanitizeValue(entryValue);
    }
    return sanitized;
  }

  return undefined;
}

export function sanitizeMiniappBootTraceDetails(
  details: MiniappBootTraceDetails | undefined,
): MiniappBootTraceDetails {
  const sanitized = sanitizeValue(details ?? {});
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }

  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_DETAILS_JSON_LENGTH) {
    return sanitized as MiniappBootTraceDetails;
  }

  return {
    truncated: true,
    length: serialized.length,
  };
}

export function sanitizeMiniappBootTraceRoute(
  value: string | null | undefined,
  baseUrl?: string,
): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value, baseUrl);
    const search = new URLSearchParams();
    parsed.searchParams.forEach((paramValue, key) => {
      search.append(
        key,
        isSensitiveMiniappBootTraceKey(key)
          ? MINIAPP_BOOT_TRACE_REDACTED
          : sanitizeMiniappBootTraceText(paramValue),
      );
    });

    const query = search.toString();
    const route = `${parsed.pathname}${query ? `?${query}` : ''}`;
    return route.slice(0, MAX_ROUTE_LENGTH);
  } catch {
    return sanitizeMiniappBootTraceText(value, MAX_ROUTE_LENGTH);
  }
}
