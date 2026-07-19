const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/iu;

export function parseEditorLinkHref(value: string): string | null {
  if (hasAsciiControl(value)) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('//')) {
    return null;
  }

  const candidate = EXPLICIT_SCHEME_PATTERN.test(trimmed)
    ? trimmed
    : `https://${trimmed.replace(/^\/+/u, '')}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:') {
      if (!parsed.hostname || parsed.username || parsed.password) {
        return null;
      }
    } else if (parsed.protocol === 'max:') {
      const userId = parsed.pathname.slice(1);
      if (
        parsed.hostname !== 'user' ||
        !parsed.pathname.startsWith('/') ||
        !userId ||
        userId.includes('/') ||
        parsed.username ||
        parsed.password ||
        parsed.port ||
        parsed.search ||
        parsed.hash
      ) {
        return null;
      }
    } else {
      return null;
    }

    return parsed.href
      .replace(/</gu, '%3C')
      .replace(/\(/gu, '%28')
      .replace(/\)/gu, '%29')
      .replace(/\[/gu, '%5B')
      .replace(/\]/gu, '%5D');
  } catch {
    return null;
  }
}

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }

  return false;
}

export function serializeEditorLinkMarkdown(content: string, value: string): string {
  const href = parseEditorLinkHref(value);
  return href && content ? `[${content}](${href})` : content;
}
