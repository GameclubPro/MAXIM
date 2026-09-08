import { broadcastLinkButtonSchema, normalizeHttpButtonUrl } from '@maxim/contracts';

import {
  escapeHtmlPreservingWhitespace,
  renderMaxTextMarkupAsHtml,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';
import type { MaxMessageButton } from '../max/max-client.service';

const TEMPLATE = /"([^"\r\n]+)"[\t ]*=[\t ]*"([^"\r\n]+)"/gu;
const MAX_QUICK_BUTTONS = 20;
const MAX_BUTTON_TEXT_LENGTH = 32;

export type ChannelQuickButtons = {
  sourceText: string;
  sourceMarkup: MaxTextMarkup[];
  sourceAttachmentTypes?: string[];
  buttons: MaxMessageButton[][];
};

export function extractChannelQuickButtons(
  text: string,
  markup: MaxTextMarkup[],
): { text: string; textFormat: 'html'; quickButtons: ChannelQuickButtons } | null {
  const removals: Array<{ start: number; end: number }> = [];
  const buttons: MaxMessageButton[][] = [];
  for (const match of text.matchAll(TEMPLATE)) {
    const label = match[1]!.trim();
    const url = normalizeHttpButtonUrl(match[2]!);
    if (!label || label.length > MAX_BUTTON_TEXT_LENGTH || !url) {
      continue;
    }
    const parsedUrl = new URL(url);
    if (
      parsedUrl.username ||
      parsedUrl.password ||
      !broadcastLinkButtonSchema.safeParse({ text: label, url }).success
    ) {
      continue;
    }
    buttons.push([{ type: 'link', text: label, url }]);
    if (buttons.length > MAX_QUICK_BUTTONS) {
      return null;
    }
    removals.push({ start: match.index, end: match.index + match[0].length });
  }
  if (buttons.length === 0) {
    return null;
  }

  // FLAG: MAX markup offsets are UTF-16 offsets. Map both ends through the exact removed spans.
  const mapOffset = (offset: number) =>
    offset -
    removals.reduce((sum, span) => sum + Math.max(0, Math.min(offset, span.end) - span.start), 0);
  let cursor = 0;
  let remaining = '';
  for (const span of removals) {
    remaining += text.slice(cursor, span.start);
    cursor = span.end;
  }
  remaining += text.slice(cursor);
  const mappedMarkup = markup.flatMap((item) => {
    const from = mapOffset(item.from);
    const length = mapOffset(item.from + item.length) - from;
    return length > 0 ? [{ ...item, from, length }] : [];
  });
  return {
    text:
      renderMaxTextMarkupAsHtml(remaining, mappedMarkup) ??
      escapeHtmlPreservingWhitespace(remaining),
    textFormat: 'html',
    quickButtons: { sourceText: text, sourceMarkup: markup, buttons },
  };
}
