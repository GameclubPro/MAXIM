export const MINIAPP_BOOT_TRACE_REDACTED = '[redacted]';

const MAX_DETAIL_STRING_LENGTH = 240;
const SENSITIVE_PARAM_PATTERN =
  /(?:token|webapp|init[_-]?data|authorization|hash|secret|sig|start(?:app|[_-]?param))/iu;
const SENSITIVE_EXACT_PARAM_KEYS = new Set(['q', 'query', 'search']);

export function isSensitiveMiniappBootTraceKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  return SENSITIVE_EXACT_PARAM_KEYS.has(normalized) || SENSITIVE_PARAM_PATTERN.test(normalized);
}

function redactChannelDialogPayloadFragments(value: string): string {
  const redactedPayload = value.replace(
    /\bcd-[A-Za-z0-9_-]{16,}/gu,
    `cd-${MINIAPP_BOOT_TRACE_REDACTED}`,
  );
  if (!/["']k["']\s*:\s*["'](?:channel-dialog|chat-dialog)["']/u.test(redactedPayload)) {
    return redactedPayload;
  }

  return redactedPayload.replace(
    /(["']t["']\s*:\s*["'])[^"']{1,512}(["'])/gu,
    `$1${MINIAPP_BOOT_TRACE_REDACTED}$2`,
  );
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeMiniappBootTraceText(
  value: string,
  maxLength = MAX_DETAIL_STRING_LENGTH,
): string {
  const redactedQueryValues = value.replace(
    /(^|[?&#\s|,;])([^=?&#\s|,;]{1,100})=([^&#\s|,;]*)/g,
    (match: string, separator: string, key: string) => {
      return isSensitiveMiniappBootTraceKey(decodeURIComponentSafe(key))
        ? `${separator}${key}=${MINIAPP_BOOT_TRACE_REDACTED}`
        : match;
    },
  );
  const redactedLaunchParamAssignments = redactedQueryValues.replace(
    /\b((?:WebAppStartParam|startapp|start[-_]?param)\s*=\s*)[^\s&#,;|]+/giu,
    (_match: string, prefix: string) => `${prefix}${MINIAPP_BOOT_TRACE_REDACTED}`,
  );
  const redactedAuthorization = redactedLaunchParamAssignments.replace(
    /\b(authorization\s*[:=]\s*)((?:bearer|initdata)\s+)?[^\r\n,;]+/giu,
    (_match: string, prefix: string, scheme = '') =>
      `${prefix}${scheme}${MINIAPP_BOOT_TRACE_REDACTED}`,
  );

  return redactChannelDialogPayloadFragments(redactedAuthorization).slice(0, maxLength);
}
