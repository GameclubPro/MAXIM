type ClipboardHtmlNode =
  | {
      type: 'root';
      children: ClipboardHtmlNode[];
    }
  | {
      type: 'element';
      tagName: string;
      attributes: Record<string, string>;
      children: ClipboardHtmlNode[];
    }
  | {
      type: 'text';
      text: string;
    };

type ClipboardInlineMark = 'bold' | 'italic' | 'underline' | 'strike';

const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;
const CLIPBOARD_MARK_ORDER: ClipboardInlineMark[] = ['strike', 'underline', 'italic', 'bold'];
const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const SKIPPED_HTML_TAGS = new Set(['script', 'style', 'noscript']);
const BLOCK_HTML_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'footer',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);
const HEADING_HTML_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
};

export function clipboardHtmlToSupportedMarkdown(html: string): string {
  const root = parseClipboardHtmlWithDom(html) ?? parseClipboardHtml(html);
  return normalizeClipboardMarkdown(serializeClipboardHtmlChildren(root.children, new Set()));
}

function parseClipboardHtmlWithDom(
  html: string,
): Extract<ClipboardHtmlNode, { type: 'root' }> | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const template = document.createElement('template');
  template.innerHTML = html;
  return {
    type: 'root',
    children: Array.from(template.content.childNodes).flatMap((node) => {
      const clipboardNode = convertClipboardDomNode(node);
      return clipboardNode ? [clipboardNode] : [];
    }),
  };
}

function convertClipboardDomNode(node: Node): ClipboardHtmlNode | null {
  if (node.nodeType === Node.TEXT_NODE) {
    return {
      type: 'text',
      text: node.textContent ?? '',
    };
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }

  const element = node as HTMLElement;
  const tagName = element.tagName.toLowerCase();
  if (SKIPPED_HTML_TAGS.has(tagName)) {
    return null;
  }

  return {
    type: 'element',
    tagName,
    attributes: Object.fromEntries(
      Array.from(element.attributes).map((attribute) => [
        attribute.name.toLowerCase(),
        attribute.value,
      ]),
    ),
    children: Array.from(element.childNodes).flatMap((child) => {
      const clipboardNode = convertClipboardDomNode(child);
      return clipboardNode ? [clipboardNode] : [];
    }),
  };
}

function parseClipboardHtml(html: string): Extract<ClipboardHtmlNode, { type: 'root' }> {
  const root: Extract<ClipboardHtmlNode, { type: 'root' }> = { type: 'root', children: [] };
  const stack: Array<Extract<ClipboardHtmlNode, { type: 'root' | 'element' }>> = [root];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart < 0) {
      appendClipboardText(stack, html.slice(cursor));
      break;
    }

    if (tagStart > cursor) {
      appendClipboardText(stack, html.slice(cursor, tagStart));
    }

    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      cursor = commentEnd >= 0 ? commentEnd + 3 : html.length;
      continue;
    }

    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd < 0) {
      appendClipboardText(stack, html.slice(tagStart));
      break;
    }

    const token = html.slice(tagStart + 1, tagEnd);
    const parsedTag = parseClipboardTagToken(token);
    cursor = tagEnd + 1;
    if (!parsedTag) {
      continue;
    }

    if (parsedTag.closing) {
      closeClipboardElement(stack, parsedTag.tagName);
      continue;
    }

    if (SKIPPED_HTML_TAGS.has(parsedTag.tagName)) {
      const closeIndex = lowerHtml.indexOf(`</${parsedTag.tagName}`, cursor);
      if (closeIndex < 0) {
        cursor = html.length;
        continue;
      }

      const closeEnd = html.indexOf('>', closeIndex);
      cursor = closeEnd >= 0 ? closeEnd + 1 : html.length;
      continue;
    }

    const element: Extract<ClipboardHtmlNode, { type: 'element' }> = {
      type: 'element',
      tagName: parsedTag.tagName,
      attributes: parsedTag.attributes,
      children: [],
    };
    currentClipboardParent(stack).children.push(element);

    if (!parsedTag.selfClosing && !VOID_HTML_TAGS.has(parsedTag.tagName)) {
      stack.push(element);
    }
  }

  return root;
}

function parseClipboardTagToken(token: string): {
  tagName: string;
  attributes: Record<string, string>;
  closing: boolean;
  selfClosing: boolean;
} | null {
  const trimmed = token.trim();
  if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('?')) {
    return null;
  }

  const closing = trimmed.startsWith('/');
  const body = closing ? trimmed.slice(1).trimStart() : trimmed;
  const tagMatch = /^([a-z][a-z0-9:-]*)/iu.exec(body);
  if (!tagMatch) {
    return null;
  }

  const tagName = (tagMatch[1] ?? '').toLowerCase();
  const attributesSource = body.slice(tagMatch[0].length);
  return {
    tagName,
    attributes: closing ? {} : parseClipboardAttributes(attributesSource),
    closing,
    selfClosing: /\/\s*$/u.test(trimmed),
  };
}

function parseClipboardAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributePattern =
    /([a-z_:][a-z0-9_:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/giu;
  let match: RegExpExecArray | null;

  while ((match = attributePattern.exec(source)) !== null) {
    const name = (match[1] ?? '').toLowerCase();
    if (!name) {
      continue;
    }

    attributes[name] = decodeClipboardHtmlEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }

  return attributes;
}

function appendClipboardText(
  stack: Array<Extract<ClipboardHtmlNode, { type: 'root' | 'element' }>>,
  rawText: string,
) {
  if (!rawText) {
    return;
  }

  currentClipboardParent(stack).children.push({
    type: 'text',
    text: decodeClipboardHtmlEntities(rawText),
  });
}

function currentClipboardParent(
  stack: Array<Extract<ClipboardHtmlNode, { type: 'root' | 'element' }>>,
): Extract<ClipboardHtmlNode, { type: 'root' | 'element' }> {
  return stack[stack.length - 1] ?? stack[0];
}

function closeClipboardElement(
  stack: Array<Extract<ClipboardHtmlNode, { type: 'root' | 'element' }>>,
  tagName: string,
) {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    const candidate = stack[index];
    if (candidate.type !== 'element' || candidate.tagName !== tagName) {
      continue;
    }

    stack.length = index;
    return;
  }
}

function serializeClipboardHtmlChildren(
  nodes: ClipboardHtmlNode[],
  activeMarks: ReadonlySet<ClipboardInlineMark>,
): string {
  return nodes.map((node) => serializeClipboardHtmlNode(node, activeMarks)).join('');
}

function serializeClipboardHtmlNode(
  node: ClipboardHtmlNode,
  activeMarks: ReadonlySet<ClipboardInlineMark>,
): string {
  if (node.type === 'text') {
    return escapeClipboardMarkdownText(node.text.replace(/\u00a0/g, ' '));
  }

  if (node.type === 'root') {
    return serializeClipboardHtmlChildren(node.children, activeMarks);
  }

  const tagName = node.tagName;
  if (tagName === 'br') {
    return '\n';
  }

  if (tagName === 'pre') {
    const code = serializeClipboardCodeBlockText(readClipboardNodeText(node));
    if (!code) {
      return '';
    }

    return appendClipboardBlockBreak(`\`\`\`\n${code}\n\`\`\``);
  }

  if (tagName === 'code') {
    const code = serializeClipboardCodeText(readClipboardNodeText(node));
    if (!code) {
      return '';
    }

    return `\`${code}\``;
  }

  const nodeMarks = resolveClipboardNodeMarks(tagName, node.attributes.style ?? '');
  const childActiveMarks = extendClipboardMarks(activeMarks, nodeMarks);
  let content = serializeClipboardHtmlChildren(node.children, childActiveMarks);
  if (!content) {
    return '';
  }

  if (tagName === 'a') {
    const href = normalizeClipboardLinkUrl(node.attributes.href ?? '');
    content = href ? `[${content}](${href})` : content;
  }

  if (HEADING_HTML_TAGS.has(tagName)) {
    const headingContent = content.replace(/\n+/gu, ' ').trim();
    return headingContent ? appendClipboardBlockBreak(`# ${headingContent}`) : '';
  }

  if (tagName === 'blockquote') {
    return appendClipboardBlockBreak(
      content
        .split('\n')
        .map((line) => (line.trim() ? `> ${line}` : line))
        .join('\n'),
    );
  }

  if (tagName === 'ul' || tagName === 'ol') {
    return serializeClipboardList(node, activeMarks, tagName === 'ol' ? 'ordered' : 'unordered');
  }

  if (tagName === 'li') {
    return appendClipboardBlockBreak(`• ${normalizeClipboardListItem(content)}`);
  }

  content = applyClipboardMarks(content, nodeMarks, activeMarks);
  return BLOCK_HTML_TAGS.has(tagName) ? appendClipboardBlockBreak(content) : content;
}

function resolveClipboardNodeMarks(tagName: string, style: string): ClipboardInlineMark[] {
  const marks = new Set<ClipboardInlineMark>();

  if (tagName === 'strong' || tagName === 'b' || tagName === 'mark') {
    marks.add('bold');
  }
  if (tagName === 'em' || tagName === 'i') {
    marks.add('italic');
  }
  if (tagName === 'u' || tagName === 'ins') {
    marks.add('underline');
  }
  if (tagName === 's' || tagName === 'strike' || tagName === 'del') {
    marks.add('strike');
  }

  const normalizedStyle = style.toLowerCase();
  if (/text-decoration[^;]*(?:line-through|strike)/iu.test(normalizedStyle)) {
    marks.add('strike');
  }
  if (/text-decoration[^;]*underline/iu.test(normalizedStyle)) {
    marks.add('underline');
  }
  if (/font-style\s*:\s*italic/iu.test(normalizedStyle)) {
    marks.add('italic');
  }
  if (/font-weight\s*:\s*(?:bold|[6-9]00|[1-9]\d{3,})/iu.test(normalizedStyle)) {
    marks.add('bold');
  }
  if (/background(?:-color)?\s*:\s*(?!\s*(?:transparent|none)\b)/iu.test(normalizedStyle)) {
    marks.add('bold');
  }

  return CLIPBOARD_MARK_ORDER.filter((mark) => marks.has(mark));
}

function serializeClipboardList(
  node: Extract<ClipboardHtmlNode, { type: 'element' }>,
  activeMarks: ReadonlySet<ClipboardInlineMark>,
  listType: 'ordered' | 'unordered',
): string {
  let itemIndex = 1;
  const rows: string[] = [];

  for (const child of node.children) {
    if (child.type === 'element' && child.tagName === 'li') {
      const content = normalizeClipboardListItem(
        serializeClipboardHtmlChildren(child.children, activeMarks),
      );
      if (content) {
        rows.push(`${listType === 'ordered' ? `${itemIndex}.` : '•'} ${content}`);
      }
      itemIndex += 1;
      continue;
    }

    const content = serializeClipboardHtmlNode(child, activeMarks).trim();
    if (content) {
      rows.push(content);
    }
  }

  return appendClipboardBlockBreak(rows.join('\n'));
}

function normalizeClipboardListItem(value: string): string {
  return value
    .replace(/\n{2,}/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n  ');
}

function extendClipboardMarks(
  activeMarks: ReadonlySet<ClipboardInlineMark>,
  nodeMarks: ClipboardInlineMark[],
): ReadonlySet<ClipboardInlineMark> {
  if (nodeMarks.length === 0) {
    return activeMarks;
  }

  return new Set([...activeMarks, ...nodeMarks]);
}

function applyClipboardMarks(
  content: string,
  nodeMarks: ClipboardInlineMark[],
  activeMarks: ReadonlySet<ClipboardInlineMark>,
): string {
  return nodeMarks.reduce((result, mark) => {
    if (activeMarks.has(mark)) {
      return result;
    }

    switch (mark) {
      case 'bold':
        return `**${result}**`;
      case 'italic':
        return `_${result}_`;
      case 'underline':
        return `++${result}++`;
      case 'strike':
        return `~~${result}~~`;
    }
  }, content);
}

function readClipboardNodeText(node: ClipboardHtmlNode): string {
  if (node.type === 'text') {
    return node.text;
  }

  return node.children.map((child) => readClipboardNodeText(child)).join('');
}

function appendClipboardBlockBreak(content: string): string {
  return content.endsWith('\n') ? `${content}\n` : `${content}\n\n`;
}

function normalizeClipboardMarkdown(value: string): string {
  return value
    .replace(/\r/gu, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trimEnd();
}

function escapeClipboardMarkdownText(value: string): string {
  return value.replace(/[\\`*_()[\]~+]/gu, '\\$&');
}

function serializeClipboardCodeText(value: string): string {
  return value.replace(/\r?\n/gu, ' ').replace(/`/gu, "'");
}

function serializeClipboardCodeBlockText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').replace(/```/gu, "'''").trimEnd();
}

function normalizeClipboardLinkUrl(value: string): string {
  const trimmed = value.trim();
  return SAFE_LINK_PATTERN.test(trimmed) ? trimmed : '';
}

function decodeClipboardHtmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (match, entity: string) => {
    const normalizedEntity = entity.toLowerCase();
    if (normalizedEntity.startsWith('#x')) {
      return decodeClipboardCodePoint(Number.parseInt(normalizedEntity.slice(2), 16), match);
    }
    if (normalizedEntity.startsWith('#')) {
      return decodeClipboardCodePoint(Number.parseInt(normalizedEntity.slice(1), 10), match);
    }

    return HTML_ENTITIES[normalizedEntity] ?? match;
  });
}

function decodeClipboardCodePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) {
    return fallback;
  }

  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}
