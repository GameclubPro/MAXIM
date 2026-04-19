export type MaxTextMarkup = {
  from: number;
  length: number;
  type:
    | 'emphasized'
    | 'heading'
    | 'link'
    | 'monospaced'
    | 'strikethrough'
    | 'strong'
    | 'underline'
    | 'user_mention';
  url: string | null;
  userLink: string | null;
};

export function renderMaxTextMarkupAsHtml(text: string, markup: MaxTextMarkup[]): string | null {
  if (markup.length === 0) {
    return null;
  }

  const openTags = new Map<
    number,
    Array<{ open: string; close: string; end: number; priority: number }>
  >();
  const closeTags = new Map<
    number,
    Array<{ close: string; start: number; end: number; priority: number }>
  >();
  const boundaries = new Set<number>([0, text.length]);

  for (const item of markup) {
    const start = item.from;
    const end = item.from + item.length;

    if (start < 0 || end <= start || end > text.length) {
      continue;
    }

    const tag = resolveMarkupHtmlTags(item, text.slice(start, end));
    if (!tag) {
      continue;
    }

    const openBucket = openTags.get(start) ?? [];
      openBucket.push({
        open: tag.open,
        close: tag.close,
        end,
        priority: tag.priority,
      });
    openTags.set(start, openBucket);

    const closeBucket = closeTags.get(end) ?? [];
      closeBucket.push({
        close: tag.close,
        start,
        end,
        priority: tag.priority,
      });
    closeTags.set(end, closeBucket);
    boundaries.add(start);
    boundaries.add(end);
  }

  if (openTags.size === 0 && closeTags.size === 0) {
    return null;
  }

  let html = '';
  let previousBoundary = 0;
  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);

  for (const boundary of sortedBoundaries) {
    if (boundary > previousBoundary) {
      html += escapeHtmlPreservingWhitespace(text.slice(previousBoundary, boundary));
    }

    const closing = closeTags.get(boundary);
    if (closing) {
      closing
        .slice()
        .sort(
          (left, right) =>
            right.start - left.start || left.end - right.end || right.priority - left.priority,
        )
        .forEach((tag) => {
          html += tag.close;
        });
    }

    const opening = openTags.get(boundary);
    if (opening) {
      opening
        .slice()
        .sort((left, right) => right.end - left.end || left.priority - right.priority)
        .forEach((tag) => {
          html += tag.open;
        });
    }
    previousBoundary = boundary;
  }

  return html;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

export function escapeHtmlPreservingWhitespace(value: string): string {
  return escapeHtml(value)
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
    .replace(/ {2,}/g, (match) => '&nbsp;'.repeat(match.length));
}

function resolveMarkupHtmlTags(
  markup: MaxTextMarkup,
  visibleText: string,
): { open: string; close: string; priority: number } | null {
  switch (markup.type) {
    case 'strong':
    case 'heading':
      return { open: '<strong>', close: '</strong>', priority: markup.type === 'heading' ? 5 : 20 };
    case 'emphasized':
      return { open: '<em>', close: '</em>', priority: 30 };
    case 'underline':
      return { open: '<u>', close: '</u>', priority: 40 };
    case 'strikethrough':
      return { open: '<del>', close: '</del>', priority: 50 };
    case 'monospaced':
      return visibleText.includes('\n')
        ? { open: '<pre>', close: '</pre>', priority: 60 }
        : { open: '<code>', close: '</code>', priority: 60 };
    case 'link':
      return markup.url
        ? {
            open: `<a href="${escapeHtmlAttribute(markup.url)}">`,
            close: '</a>',
            priority: 10,
          }
        : null;
    case 'user_mention': {
      const mentionTarget = resolveMentionHref(markup.userLink);
      return mentionTarget
        ? {
            open: `<a href="${escapeHtmlAttribute(mentionTarget)}">`,
            close: '</a>',
            priority: 10,
          }
        : null;
    }
    default:
      return null;
  }
}

function resolveMentionHref(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  if (/^(?:max:\/\/|https?:\/\/)/iu.test(normalized)) {
    return normalized;
  }

  const trimmed = normalized.replace(/^\/+/u, '');
  if (trimmed.startsWith('user/')) {
    return `max://${trimmed}`;
  }

  return `https://max.ru/${trimmed}`;
}
