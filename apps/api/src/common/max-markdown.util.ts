type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike'; children: InlineToken[] }
  | { type: 'code'; content: string }
  | { type: 'link'; href: string; children: InlineToken[] };

const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;
const SUPPORTED_MARKDOWN_PATTERN =
  /(?:^#{1,6}\s+\S.*$|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|~~[^~\n]+?~~|\+\+[^+\n]+?\+\+|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|max:\/\/)[^)]+\))/mu;

export function containsSupportedMarkdownSyntax(source: string): boolean {
  return SUPPORTED_MARKDOWN_PATTERN.test(source.replace(/\r/g, '').trim());
}

export function renderSupportedMarkdownAsHtml(source: string): string {
  const normalized = source.replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const renderedLines = paragraphLines.map((line) => renderInlineTokens(parseInlineTokens(line)));
    blocks.push(`<p>${renderedLines.join('<br>')}</p>`);
    paragraphLines = [];
  };

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = /^(#{1,6})[ \t]+(.+)$/u.exec(trimmedLine);
    if (headingMatch) {
      flushParagraph();
      const level = Math.min(6, headingMatch[1]?.length ?? 1);
      const content = renderInlineTokens(parseInlineTokens(headingMatch[2] ?? ''));
      blocks.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('');
}

export function stripSupportedMarkdownToPlainText(source: string): string {
  const normalized = source.replace(/\r/g, '').trim();
  if (!normalized) {
    return '';
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push(
      paragraphLines.map((line) => renderInlineTokensAsPlainText(parseInlineTokens(line))).join('\n'),
    );
    paragraphLines = [];
  };

  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = /^(#{1,6})[ \t]+(.+)$/u.exec(trimmedLine);
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

function renderInlineTokens(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return escapeHtml(token.content);
        case 'code':
          return `<code>${escapeHtml(token.content)}</code>`;
        case 'bold':
          return `<strong>${renderInlineTokens(token.children)}</strong>`;
        case 'italic':
          return `<em>${renderInlineTokens(token.children)}</em>`;
        case 'underline':
          return `<u>${renderInlineTokens(token.children)}</u>`;
        case 'strike':
          return `<s>${renderInlineTokens(token.children)}</s>`;
        case 'link':
          return `<a href="${escapeAttribute(token.href)}">${renderInlineTokens(token.children)}</a>`;
      }
    })
    .join('');
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

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
