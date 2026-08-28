const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;

const MULTILINE_INLINE_MARKERS = [
  '***',
  '___',
  '**',
  '__',
  '++',
  '~~',
  '^^',
  '*',
  '_',
] as const;

type MultilineInlineMarker = (typeof MULTILINE_INLINE_MARKERS)[number];

type MultilineInlineSpan = {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  open: string;
  close: string;
};

/**
 * The rich editor can serialize one inline entity across several paragraphs.
 * Pair delimiters in one bounded scan, then close and reopen active entities at
 * line boundaries so MAX never receives raw generated markers.
 */
export function normalizeLegacyMultilineMarkdown(source: string): string {
  if (!source.includes('\n')) {
    return source;
  }
  const context = buildMultilineScanContext(source);
  const spans = collectMultilineInlineSpans(source, context);
  return spans.length > 0 ? renderLineBoundedMarkdown(source, spans, context) : source;
}

type MultilineScanContext = {
  escaped: Uint8Array;
  protected: Uint8Array;
  fenced: Uint8Array;
  url: Uint8Array;
  lineStart: Int32Array;
  lineEnd: Int32Array;
  newlinePrefix: Int32Array;
};

type PendingInlineFrame = {
  openStart: number;
  openEnd: number;
  open: string;
  marker: MultilineInlineMarker | null;
  invalid: boolean;
};

function buildMultilineScanContext(source: string): MultilineScanContext {
  const escaped = new Uint8Array(source.length);
  const protectedMask = new Uint8Array(source.length);
  const fencedMask = new Uint8Array(source.length);
  const url = new Uint8Array(source.length);
  const lineStart = new Int32Array(source.length);
  const lineEnd = new Int32Array(source.length);
  const newlinePrefix = new Int32Array(source.length + 1);

  let backslashRun = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') {
      backslashRun += 1;
    } else {
      if (backslashRun % 2 === 1) {
        escaped[index] = 1;
      }
      backslashRun = 0;
    }
    newlinePrefix[index + 1] = newlinePrefix[index] + (source[index] === '\n' ? 1 : 0);
  }

  let cursor = 0;
  let fenced = false;
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, end);
    const fenceLine = line.trim().startsWith('```');
    const protectLine = fenced || fenceLine;
    for (let index = cursor; index < end; index += 1) {
      lineStart[index] = cursor;
      lineEnd[index] = end;
      if (protectLine) {
        protectedMask[index] = 1;
        fencedMask[index] = 1;
      }
    }
    if (newline !== -1) {
      lineStart[newline] = cursor;
      lineEnd[newline] = end;
      if (protectLine) {
        protectedMask[newline] = 1;
        fencedMask[newline] = 1;
      }
    }
    if (fenceLine) fenced = !fenced;
    if (newline === -1) break;
    cursor = newline + 1;
  }

  const urlPattern = /(?:https?:\/\/|max:\/\/)[^\s<>()\]["'`{}]+/giu;
  for (const match of source.matchAll(urlPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    url.fill(1, start, end);
  }

  for (let index = 0; index < source.length; index += 1) {
    if (protectedMask[index] || source[index] !== '`' || escaped[index]) continue;
    const end = source.indexOf('`', index + 1);
    const boundedEnd = end === -1 || end > lineEnd[index] ? lineEnd[index] : end;
    protectedMask.fill(1, index, Math.min(source.length, boundedEnd + 1));
    index = boundedEnd;
  }

  return {
    escaped,
    protected: protectedMask,
    fenced: fencedMask,
    url,
    lineStart,
    lineEnd,
    newlinePrefix,
  };
}

function collectMultilineInlineSpans(
  source: string,
  context: MultilineScanContext,
): MultilineInlineSpan[] {
  const frames = new Map<string, PendingInlineFrame>();
  const spans: MultilineInlineSpan[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (context.fenced[index]) {
      frames.clear();
      continue;
    }
    if (context.protected[index]) continue;

    const linkClose = readLinkCloseAt(source, index, context);
    if (linkClose) {
      const frame = frames.get('link');
      if (frame) {
        frames.delete('link');
        if (!frame.invalid && context.newlinePrefix[index] > context.newlinePrefix[frame.openEnd]) {
          spans.push({
            openStart: frame.openStart,
            openEnd: frame.openEnd,
            closeStart: index,
            closeEnd: linkClose.closeEnd,
            open: '[',
            close: source.slice(index, linkClose.closeEnd),
          });
        }
        index = linkClose.closeEnd - 1;
        continue;
      }
    }

    if (
      source[index] === '[' &&
      !context.escaped[index] &&
      !context.url[index] &&
      !/\s/u.test(source[index + 1] ?? '')
    ) {
      const current = frames.get('link');
      if (current) current.invalid = true;
      else
        frames.set('link', {
          openStart: index,
          openEnd: index + 1,
          open: '[',
          marker: null,
          invalid: false,
        });
      continue;
    }

    const marker = MULTILINE_INLINE_MARKERS.find((candidate) =>
      isMarkerAt(source, index, candidate, context),
    );
    if (!marker) continue;
    const canClose =
      isLikelyMarkerClose(source, index, marker, context) ||
      isStandaloneMarkerLine(source, index, marker, context);
    const frame = frames.get(marker);
    if (canClose && frame) {
      frames.delete(marker);
      if (!frame.invalid && context.newlinePrefix[index] > context.newlinePrefix[frame.openEnd]) {
        spans.push({
          openStart: frame.openStart,
          openEnd: frame.openEnd,
          closeStart: index,
          closeEnd: index + marker.length,
          open: marker,
          close: marker,
        });
      }
      index += marker.length - 1;
      continue;
    }
    if (isLikelyMarkerOpen(source, index, marker, context)) {
      if (frame) frame.invalid = true;
      else
        frames.set(marker, {
          openStart: index,
          openEnd: index + marker.length,
          open: marker,
          marker,
          invalid: false,
        });
      index += marker.length - 1;
    }
  }

  return discardCrossingSpans(spans);
}

function discardCrossingSpans(spans: MultilineInlineSpan[]): MultilineInlineSpan[] {
  const sorted = spans
    .slice()
    .sort((left, right) => left.openStart - right.openStart || right.closeEnd - left.closeEnd);
  const accepted: MultilineInlineSpan[] = [];
  const stack: MultilineInlineSpan[] = [];
  for (const span of sorted) {
    while (stack.length > 0 && (stack.at(-1)?.closeEnd ?? 0) <= span.openStart) stack.pop();
    const parent = stack.at(-1);
    if (parent && span.closeEnd > parent.closeStart) continue;
    accepted.push(span);
    stack.push(span);
  }
  return accepted;
}

function renderLineBoundedMarkdown(
  source: string,
  spans: MultilineInlineSpan[],
  context: MultilineScanContext,
): string {
  const opening = new Map(spans.map((span) => [span.openStart, span]));
  const closing = new Map(spans.map((span) => [span.closeStart, span]));
  const active: MultilineInlineSpan[] = [];
  let pending: MultilineInlineSpan[] | null = null;
  let output = '';
  let suppressLineBreak = false;

  for (let index = 0; index < source.length; ) {
    const lineEnd = context.lineEnd[index] ?? source.length;
    if (pending?.length && index === (context.lineStart[index] ?? index)) {
      suppressLineBreak = lineContainsOnlyPendingClosers(source, index, lineEnd, pending, closing);
      if (!suppressLineBreak) {
        if (source.slice(index, lineEnd).trim()) {
          output += pending.map((span) => span.open).join('');
          pending = null;
        }
      }
    }

    const openSpan = opening.get(index);
    if (openSpan) {
      output += source.slice(openSpan.openStart, openSpan.openEnd);
      active.push(openSpan);
      index = openSpan.openEnd;
      continue;
    }
    const closeSpan = closing.get(index);
    if (closeSpan) {
      const physicallyClosed = Boolean(pending?.includes(closeSpan));
      if (!physicallyClosed) output += source.slice(closeSpan.closeStart, closeSpan.closeEnd);
      const activeIndex = active.lastIndexOf(closeSpan);
      if (activeIndex >= 0) active.splice(activeIndex, 1);
      if (pending) {
        pending = pending.filter((span) => span !== closeSpan);
        if (pending.length === 0) pending = null;
      }
      index = closeSpan.closeEnd;
      continue;
    }
    if (source[index] === '\n') {
      if (!pending && active.length > 0) {
        output += active
          .slice()
          .reverse()
          .map((span) => span.close)
          .join('');
        pending = active.slice();
      }
      if (!suppressLineBreak) output += '\n';
      suppressLineBreak = false;
      index += 1;
      continue;
    }

    const ambiguous = active
      .slice()
      .reverse()
      .find(
        (span) =>
          span.open === span.close &&
          source.startsWith(span.open, index) &&
          isAmbiguousMarkerPosition(source, index, span.open as MultilineInlineMarker, context),
      );
    if (ambiguous) {
      output += [...ambiguous.open].map((character) => `\\${character}`).join('');
      index += ambiguous.open.length;
      continue;
    }
    output += source[index] ?? '';
    index += 1;
  }
  return output;
}

function lineContainsOnlyPendingClosers(
  source: string,
  start: number,
  end: number,
  pending: MultilineInlineSpan[],
  closing: Map<number, MultilineInlineSpan>,
): boolean {
  let cursor = start;
  let found = false;
  while (cursor < end) {
    if (/\s/u.test(source[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    const span = closing.get(cursor);
    if (!span || !pending.includes(span)) return false;
    found = true;
    cursor = span.closeEnd;
  }
  return found;
}

function isMarkerAt(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  if (!source.startsWith(marker, index) || context.escaped[index] || context.protected[index]) {
    return false;
  }
  const character = marker[0];
  return source[index - 1] !== character && source[index + marker.length] !== character;
}

function isLikelyMarkerOpen(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return (
    next.length > 0 && !/\s/u.test(next) && !/[\p{L}\p{N}]/u.test(previous) && !context.url[index]
  );
}

function isLikelyMarkerClose(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return (
    previous.length > 0 &&
    !/\s/u.test(previous) &&
    !(/[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) &&
    (!context.url[index] || !context.url[index + marker.length])
  );
}

function isStandaloneMarkerLine(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  return source.slice(context.lineStart[index], context.lineEnd[index]).trim() === marker;
}

function isAmbiguousMarkerPosition(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  if (!isMarkerAt(source, index, marker, context)) return false;
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return context.url[index] === 1 || (/[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next));
}

function readLinkCloseAt(
  source: string,
  index: number,
  context: MultilineScanContext,
): { closeEnd: number } | null {
  if (
    source[index] !== ']' ||
    source[index + 1] !== '(' ||
    context.escaped[index] ||
    context.protected[index]
  ) {
    return null;
  }
  const destinationEnd = source.indexOf(')', index + 2);
  if (destinationEnd === -1) return null;
  const destination = source.slice(index + 2, destinationEnd);
  return destination && !/\s/u.test(destination) && SAFE_LINK_PATTERN.test(destination)
    ? { closeEnd: destinationEnd + 1 }
    : null;
}
