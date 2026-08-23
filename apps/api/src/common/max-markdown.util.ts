type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike'; children: InlineToken[] }
  | { type: 'code'; content: string }
  | { type: 'link'; href: string; children: InlineToken[] };

type RenderMarkdownOptions = {
  linkMode?: 'anchor' | 'underline';
  blockMode?: 'paragraphs' | 'raw';
};

const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;
const HEADING_LINE_PATTERN = /^(#{1,6})[ \t]+(.+)$/u;
const SUPPORTED_MARKDOWN_PATTERN =
  /(?:^#{1,6}\s+\S.*$|```[\s\S]+?```|\*\*\*[^*\n]+?\*\*\*|___[^_\n]+?___|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|~~[^~\n]+?~~|\+\+[^+\n]+?\+\+|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|max:\/\/)[^)]+\))/mu;
const ESCAPABLE_MARKDOWN_CHARACTERS = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '~', '+']);
const MULTILINE_STRONG_MARKERS = ['**', '__'] as const;

export function containsSupportedMarkdownSyntax(source: string): boolean {
  return SUPPORTED_MARKDOWN_PATTERN.test(
    normalizeMultilineStrongMarkdown(source.replace(/\r/g, '').trim()),
  );
}

export function renderSupportedMarkdownAsHtml(
  source: string,
  options: RenderMarkdownOptions = {},
): string {
  const normalized = normalizeMultilineStrongMarkdown(source.replace(/\r/g, ''));
  if (!normalized.trim()) {
    return '';
  }

  if (options.blockMode === 'raw') {
    const renderedLines: string[] = [];
    const lines = normalized.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const fencedCodeBlock = readFencedCodeBlock(lines, index);
      if (fencedCodeBlock) {
        renderedLines.push(renderCodeBlockHtml(fencedCodeBlock.content));
        index = fencedCodeBlock.nextIndex - 1;
        continue;
      }

      const rawLine = lines[index] ?? '';
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) {
        renderedLines.push('');
        continue;
      }

      const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
      if (headingMatch) {
        const content = renderInlineTokens(parseInlineTokens(headingMatch[2] ?? ''), options);
        renderedLines.push(renderHeadingHtml(content));
        continue;
      }

      renderedLines.push(renderInlineTokens(parseInlineTokens(rawLine), options));
    }

    return renderedLines.join('\n');
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const lines = normalized.split('\n');

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const renderedLines = paragraphLines.map((line) =>
      renderInlineTokens(parseInlineTokens(line), options),
    );
    blocks.push(`<p>${renderedLines.join('<br>')}</p>`);
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      flushParagraph();
      blocks.push(renderCodeBlockHtml(fencedCodeBlock.content));
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    const rawLine = lines[index] ?? '';
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
    if (headingMatch) {
      flushParagraph();
      const content = renderInlineTokens(parseInlineTokens(headingMatch[2] ?? ''), options);
      blocks.push(`<p>${renderHeadingHtml(content)}</p>`);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('');
}

export function stripSupportedMarkdownToPlainText(source: string): string {
  const normalized = normalizeMultilineStrongMarkdown(source.replace(/\r/g, '').trim());
  if (!normalized) {
    return '';
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const lines = normalized.split('\n');

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push(
      paragraphLines
        .map((line) => renderInlineTokensAsPlainText(parseInlineTokens(line)))
        .join('\n'),
    );
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      flushParagraph();
      blocks.push(fencedCodeBlock.content);
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    const rawLine = lines[index] ?? '';
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
    if (headingMatch) {
      flushParagraph();
      blocks.push(renderInlineTokensAsPlainText(parseInlineTokens(headingMatch[2] ?? '')));
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('\n\n');
}

export function extractSupportedMarkdownLinks(source: string): string[] {
  const links = new Set<string>();
  const lines = normalizeMultilineStrongMarkdown(source.replace(/\r/g, '')).split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    collectInlineTokenLinks(parseInlineTokens(lines[index] ?? ''), links);
  }

  return [...links];
}

export function containsSupportedMarkdownUrl(source: string, url: string): boolean {
  if (!url) {
    return false;
  }
  return (
    extractSupportedMarkdownLinks(source).includes(url) ||
    stripSupportedMarkdownToPlainText(source).includes(url)
  );
}

function collectInlineTokenLinks(tokens: InlineToken[], links: Set<string>): void {
  for (const token of tokens) {
    if (token.type === 'link') {
      links.add(token.href);
      collectInlineTokenLinks(token.children, links);
      continue;
    }
    if ('children' in token) {
      collectInlineTokenLinks(token.children, links);
    }
  }
}

/**
 * The editor can wrap a selection that crosses paragraph boundaries in one pair
 * of strong markers. MAX accepts strong markup per line, so expand that legacy
 * shape into independent line spans before the regular inline parser runs.
 */
function normalizeMultilineStrongMarkdown(source: string): string {
  let normalized = source;
  let searchStart = 0;

  while (searchStart < normalized.length) {
    const span = findMultilineStrongSpan(normalized, searchStart);
    if (!span) {
      break;
    }

    let replacement = wrapMultilineStrongContent(
      span.marker,
      normalized.slice(span.openEnd, span.closeStart),
    );
    const closeLineEnd = normalized.indexOf('\n', span.closeEnd);
    const closeLineRemainder = normalized.slice(
      span.closeEnd,
      closeLineEnd === -1 ? normalized.length : closeLineEnd,
    );
    if (closeLineRemainder.trim().length === 0 && normalized[span.closeEnd] === '\n') {
      replacement = replacement.replace(/\n$/u, '');
    }
    normalized =
      normalized.slice(0, span.openStart) + replacement + normalized.slice(span.closeEnd);
    searchStart = span.openStart + replacement.length;
  }

  return normalized;
}

function findMultilineStrongSpan(
  source: string,
  searchStart: number,
): {
  marker: (typeof MULTILINE_STRONG_MARKERS)[number];
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
} | null {
  for (let index = searchStart; index < source.length; index += 1) {
    const marker = MULTILINE_STRONG_MARKERS.find((candidate) =>
      isMarkdownMarkerAt(source, index, candidate),
    );
    if (
      !marker ||
      !isLikelyStrongOpening(source, index) ||
      hasEarlierMarkerOnLine(source, index, marker) ||
      isInsideFencedCodeBlock(source, index)
    ) {
      continue;
    }

    const lineEnd = source.indexOf('\n', index + marker.length);
    const sameLineEnd = lineEnd === -1 ? source.length : lineEnd;
    if (findNextMarkdownMarker(source, index + marker.length, sameLineEnd, marker) !== null) {
      continue;
    }

    const closeStart = findMultilineStrongClose(source, index + marker.length, marker);
    if (closeStart === null || !source.slice(index + marker.length, closeStart).includes('\n')) {
      continue;
    }

    return {
      marker,
      openStart: index,
      openEnd: index + marker.length,
      closeStart,
      closeEnd: closeStart + marker.length,
    };
  }

  return null;
}

function hasEarlierMarkerOnLine(
  source: string,
  index: number,
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return findPreviousMarkdownMarker(source, lineStart, index, marker) !== null;
}

function isLikelyStrongOpening(source: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = source[index - 1] ?? '';
  return previous !== '\\' && !/[\p{L}\p{N}]/u.test(previous);
}

function findMultilineStrongClose(
  source: string,
  searchStart: number,
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
): number | null {
  for (let index = searchStart; index < source.length; index += 1) {
    if (!isMarkdownMarkerAt(source, index, marker) || isInsideFencedCodeBlock(source, index)) {
      continue;
    }

    const lineEnd = source.indexOf('\n', index + marker.length);
    const remainder = source.slice(index + marker.length, lineEnd === -1 ? source.length : lineEnd);
    const trimmedRemainder = remainder.trim();
    const nextMarkerOnLine = findNextMarkdownMarker(
      source,
      index + marker.length,
      lineEnd === -1 ? source.length : lineEnd,
      marker,
    );
    if (
      !trimmedRemainder ||
      /^[\p{P}\p{S}]+$/u.test(trimmedRemainder) ||
      !isLikelyStrongOpening(source, index) ||
      nextMarkerOnLine === null
    ) {
      return index;
    }
  }

  return null;
}

function findNextMarkdownMarker(
  source: string,
  searchStart: number,
  end: number,
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
): number | null {
  for (let index = searchStart; index < end; index += 1) {
    if (isMarkdownMarkerAt(source, index, marker)) {
      return index;
    }
  }
  return null;
}

function findPreviousMarkdownMarker(
  source: string,
  start: number,
  end: number,
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
): number | null {
  for (let index = end - marker.length; index >= start; index -= 1) {
    if (isMarkdownMarkerAt(source, index, marker)) {
      return index;
    }
  }
  return null;
}

function isMarkdownMarkerAt(
  source: string,
  index: number,
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
): boolean {
  if (!source.startsWith(marker, index)) {
    return false;
  }

  const markerCharacter = marker[0];
  if (source[index - 1] === markerCharacter || source[index + marker.length] === markerCharacter) {
    return false;
  }

  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 0;
}

function isInsideFencedCodeBlock(source: string, index: number): boolean {
  const lines = source.slice(0, index + 1).split('\n');
  let inside = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inside = !inside;
    }
  }
  return inside;
}

function wrapMultilineStrongContent(
  marker: (typeof MULTILINE_STRONG_MARKERS)[number],
  content: string,
): string {
  return content
    .split('\n')
    .map((line) => (line.trim().length > 0 ? `${marker}${line}${marker}` : line))
    .join('\n');
}

function renderHeadingHtml(content: string): string {
  return `<strong>${content}</strong>`;
}

function renderCodeBlockHtml(content: string): string {
  return `<pre>${escapeHtmlPreservingWhitespace(content)}</pre>`;
}

function readFencedCodeBlock(
  lines: string[],
  startIndex: number,
): { content: string; nextIndex: number } | null {
  const openingLine = lines[startIndex]?.trim();
  if (!openingLine?.startsWith('```')) {
    return null;
  }

  const codeLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('```')) {
      return {
        content: codeLines.join('\n'),
        nextIndex: index + 1,
      };
    }

    codeLines.push(line);
  }

  return {
    content: codeLines.join('\n'),
    nextIndex: lines.length,
  };
}

function parseInlineTokens(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let plainText = '';

  const flushPlainText = () => {
    if (!plainText) {
      return;
    }

    tokens.push({ type: 'text', content: plainText });
    plainText = '';
  };

  while (cursor < source.length) {
    if (
      source[cursor] === '\\' &&
      cursor + 1 < source.length &&
      ESCAPABLE_MARKDOWN_CHARACTERS.has(source[cursor + 1] ?? '')
    ) {
      plainText += source[cursor + 1];
      cursor += 2;
      continue;
    }

    const token = matchToken(source.slice(cursor));
    if (!token) {
      plainText += source[cursor];
      cursor += 1;
      continue;
    }

    flushPlainText();
    tokens.push(token.node);
    cursor += token.rawLength;
  }

  flushPlainText();
  return tokens;
}

function matchToken(value: string): {
  rawLength: number;
  node: InlineToken;
} | null {
  const linkMatch = /^\[([^\]\n]+)\]\(([^)\s]+)\)/u.exec(value);
  if (linkMatch) {
    const href = linkMatch[2] ?? '';
    if (!SAFE_LINK_PATTERN.test(href)) {
      return null;
    }

    return {
      rawLength: linkMatch[0].length,
      node: {
        type: 'link',
        href,
        children: parseInlineTokens(linkMatch[1] ?? ''),
      },
    };
  }

  const codeMatch = /^`([^`\n]+)`/u.exec(value);
  if (codeMatch) {
    return {
      rawLength: codeMatch[0].length,
      node: {
        type: 'code',
        content: codeMatch[1] ?? '',
      },
    };
  }

  const boldItalicMatch = /^(?:\*\*\*([^\n]+?)\*\*\*|___([^\n]+?)___)/u.exec(value);
  if (boldItalicMatch) {
    return {
      rawLength: boldItalicMatch[0].length,
      node: {
        type: 'bold',
        children: [
          {
            type: 'italic',
            children: parseInlineTokens(boldItalicMatch[1] ?? boldItalicMatch[2] ?? ''),
          },
        ],
      },
    };
  }

  const boldMatch = /^(?:\*\*([^\n]+?)\*\*|__([^\n]+?)__)/u.exec(value);
  if (boldMatch) {
    return {
      rawLength: boldMatch[0].length,
      node: {
        type: 'bold',
        children: parseInlineTokens(boldMatch[1] ?? boldMatch[2] ?? ''),
      },
    };
  }

  const underlineMatch = /^\+\+([^\n]+?)\+\+/u.exec(value);
  if (underlineMatch) {
    return {
      rawLength: underlineMatch[0].length,
      node: {
        type: 'underline',
        children: parseInlineTokens(underlineMatch[1] ?? ''),
      },
    };
  }

  const strikeMatch = /^~~([^\n]+?)~~/u.exec(value);
  if (strikeMatch) {
    return {
      rawLength: strikeMatch[0].length,
      node: {
        type: 'strike',
        children: parseInlineTokens(strikeMatch[1] ?? ''),
      },
    };
  }

  const italicMatch = /^(?:\*([^\n]+?)\*|_([^\n]+?)_)/u.exec(value);
  if (italicMatch) {
    return {
      rawLength: italicMatch[0].length,
      node: {
        type: 'italic',
        children: parseInlineTokens(italicMatch[1] ?? italicMatch[2] ?? ''),
      },
    };
  }

  return null;
}

function renderInlineTokens(tokens: InlineToken[], options: RenderMarkdownOptions): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return escapeHtmlPreservingWhitespace(token.content);
        case 'code':
          return `<code>${escapeHtmlPreservingWhitespace(token.content)}</code>`;
        case 'bold':
          return `<strong>${renderInlineTokens(token.children, options)}</strong>`;
        case 'italic':
          return `<em>${renderInlineTokens(token.children, options)}</em>`;
        case 'underline':
          return `<u>${renderInlineTokens(token.children, options)}</u>`;
        case 'strike':
          return `<s>${renderInlineTokens(token.children, options)}</s>`;
        case 'link':
          return renderLinkHtml(token, options);
      }
    })
    .join('');
}

function renderLinkHtml(
  token: Extract<InlineToken, { type: 'link' }>,
  options: RenderMarkdownOptions,
): string {
  const labelHtml = renderLinkLabelHtml(token, options);
  if (options.linkMode === 'underline') {
    return `<u>${labelHtml}</u>`;
  }

  return `<a href="${escapeAttribute(token.href)}">${labelHtml}</a>`;
}

function renderLinkLabelHtml(
  token: Extract<InlineToken, { type: 'link' }>,
  options: RenderMarkdownOptions,
): string {
  const plainLabel = renderInlineTokensAsPlainText(token.children).trim();
  if (!plainLabel) {
    return escapeHtml(token.href);
  }

  if (looksLikeUrlLabel(plainLabel, token.href)) {
    return escapeHtml(insertSoftBreaks(plainLabel));
  }

  return renderInlineTokens(token.children, options);
}

function looksLikeUrlLabel(label: string, href: string): boolean {
  if (!SAFE_LINK_PATTERN.test(label)) {
    return false;
  }

  return normalizeComparableUrl(label) === normalizeComparableUrl(href);
}

function normalizeComparableUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

function insertSoftBreaks(value: string): string {
  return value.replace(/([/.:?&=#_-])/g, '$1\u200B');
}

function renderInlineTokensAsPlainText(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.content;
        case 'code':
          return token.content;
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strike':
        case 'link':
          return renderInlineTokensAsPlainText(token.children);
      }
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlPreservingWhitespace(value: string): string {
  return escapeHtml(value)
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
    .replace(/ {2,}/g, (match) => '&nbsp;'.repeat(match.length));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
