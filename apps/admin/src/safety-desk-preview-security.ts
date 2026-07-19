import type { SupportRequestAttachment } from '@maxim/contracts/support-requests';

const ALLOWED_PREVIEW_TAGS = new Set(['p', 'br', 'strong', 'em', 'u', 's', 'code', 'pre']);
const BLOCKED_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'form',
  'textarea',
  'title',
  'noscript',
]);
const HTML_TAG_PATTERN = /^<\s*(\/?)\s*([a-z][a-z0-9]*)(?:\s[^>]*)?\/?\s*>$/iu;
const SAFE_ENTITY_PATTERN = /&(?!(?:amp|lt|gt|quot|apos|#39|#\d{1,7}|#x[a-f\d]{1,6});)/giu;

declare const safeExternalUrlBrand: unique symbol;
export type SafeExternalUrl = string & { readonly [safeExternalUrlBrand]: true };

declare const sanitizedPreviewHtmlBrand: unique symbol;
export type SanitizedPreviewHtml = string & { readonly [sanitizedPreviewHtmlBrand]: true };

export function sanitizeExternalHttpUrl(value: unknown): SafeExternalUrl | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.href as SafeExternalUrl;
  } catch {
    return null;
  }
}

export function sanitizeExternalHttpUrls(values: readonly string[]): SafeExternalUrl[] {
  return values.flatMap((value) => {
    const safeUrl = sanitizeExternalHttpUrl(value);
    return safeUrl ? [safeUrl] : [];
  });
}

export function resolveSupportAttachmentUrl(
  attachment: SupportRequestAttachment,
): SafeExternalUrl | null {
  const directUrl = sanitizeExternalHttpUrl(attachment.url);
  if (directUrl) {
    return directUrl;
  }

  const payload = attachment.payload;
  if (!payload) {
    return null;
  }

  const candidates = [
    payload.url,
    payload.preview_url,
    payload.previewUrl,
    payload.thumbnail_url,
    payload.thumbnailUrl,
    payload.src,
    payload.href,
  ];

  for (const candidate of candidates) {
    const safeUrl = sanitizeExternalHttpUrl(candidate);
    if (safeUrl) {
      return safeUrl;
    }
  }

  return null;
}

export function formatExternalUrlLabel(value: SafeExternalUrl): string {
  return new URL(value).hostname || value;
}

export function sanitizeSafetyDeskPreviewHtml(value: string): SanitizedPreviewHtml {
  let cursor = 0;
  let result = '';

  while (cursor < value.length) {
    const tagStart = value.indexOf('<', cursor);
    if (tagStart === -1) {
      result += escapePreviewText(value.slice(cursor));
      break;
    }

    result += escapePreviewText(value.slice(cursor, tagStart));

    if (value.startsWith('<!--', tagStart)) {
      const commentEnd = value.indexOf('-->', tagStart + 4);
      cursor = commentEnd === -1 ? value.length : commentEnd + 3;
      continue;
    }

    const tagEnd = value.indexOf('>', tagStart + 1);
    if (tagEnd === -1) {
      result += escapePreviewText(value.slice(tagStart));
      break;
    }

    const source = value.slice(tagStart, tagEnd + 1);
    const match = HTML_TAG_PATTERN.exec(source);
    if (!match) {
      result += escapePreviewText(source);
      cursor = tagEnd + 1;
      continue;
    }

    const closing = Boolean(match[1]);
    const tagName = (match[2] ?? '').toLowerCase();
    if (!closing && BLOCKED_CONTENT_TAGS.has(tagName)) {
      cursor = skipBlockedElement(value, tagEnd + 1, tagName);
      continue;
    }

    if (ALLOWED_PREVIEW_TAGS.has(tagName)) {
      result += tagName === 'br' ? '<br>' : closing ? `</${tagName}>` : `<${tagName}>`;
    }
    cursor = tagEnd + 1;
  }

  return result as SanitizedPreviewHtml;
}

function skipBlockedElement(value: string, cursor: number, tagName: string): number {
  const closingPattern = new RegExp(`<\\s*\\/\\s*${tagName}\\s*>`, 'iu');
  const closingMatch = closingPattern.exec(value.slice(cursor));
  return closingMatch ? cursor + closingMatch.index + closingMatch[0].length : value.length;
}

function escapePreviewText(value: string): string {
  return value.replace(SAFE_ENTITY_PATTERN, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
