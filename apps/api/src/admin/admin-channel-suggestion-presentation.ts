import type { BroadcastTextFormat } from '@maxim/contracts';
import { renderSupportedMarkdownAsHtml } from '../common/max-markdown.util';
import {
  escapeHtml,
  escapeHtmlAttribute,
  escapeHtmlPreservingWhitespace,
  renderMaxTextMarkupAsHtml,
} from '../common/max-text-markup.util';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import { readTrimmedString } from './admin-legacy-utils';
import { normalizeMaxProfileUrl } from './admin-profile-links';
import type {
  ChannelSuggestionAuthorAttribution,
  ChannelSuggestionTextMarkup,
} from './admin.service.support';

type ChannelSuggestionMessagePayload = {
  text: string;
  textFormat: MaxSendMessageOptions['textFormat'];
};

function escapeMarkdown(value: string): string {
  return value.replace(/([\\_*[\]()`])/g, '\\$1');
}

function escapeMarkdownPlainText(value: string): string {
  return value.replace(/([\\`*_[\]()~+#])/g, '\\$1');
}

function markdownTitle(title: string): string {
  return `**${escapeMarkdown(title)}**`;
}

function renderChannelSuggestionTextHtml(
  value: string,
  textMarkup: ChannelSuggestionTextMarkup[],
  textFormat: BroadcastTextFormat | null | undefined,
): string | null {
  if (textMarkup.length > 0) {
    return renderMaxTextMarkupAsHtml(value, textMarkup) ?? escapeHtmlPreservingWhitespace(value);
  }

  if (textFormat === 'markdown') {
    return renderSupportedMarkdownAsHtml(value, { blockMode: 'raw' });
  }

  return null;
}

function renderSuggestionTextForMarkdown(
  value: string,
  textFormat: BroadcastTextFormat | null | undefined,
): string {
  return textFormat === 'markdown' ? value : escapeMarkdownPlainText(value);
}

function renderChannelSuggestionAuthorLink(
  author: ChannelSuggestionAuthorAttribution,
  format: 'html' | 'markdown',
): string {
  const displayName = readTrimmedString(author.displayName);
  const mentionDisplayName = readTrimmedString(author.mentionDisplayName);
  const username = readTrimmedString(author.username)?.replace(/^@+/u, '').trim() ?? '';
  const userId = readTrimmedString(author.userId);
  const profileUrl = normalizeMaxProfileUrl(readTrimmedString(author.profileUrl)) ?? null;
  const mentionUrl =
    mentionDisplayName && userId ? `max://user/${encodeURIComponent(userId)}` : null;
  const target = profileUrl ?? mentionUrl;
  const label =
    (profileUrl ? displayName : mentionDisplayName) ??
    displayName ??
    (username ? `@${username}` : (userId ?? 'Пользователь'));

  if (format === 'html') {
    const safeLabel = escapeHtml(label);
    return target ? `<a href="${escapeHtmlAttribute(target)}">${safeLabel}</a>` : safeLabel;
  }

  const safeLabel = escapeMarkdownPlainText(label);
  return target ? `[${safeLabel}](${target})` : safeLabel;
}

export function buildChannelSuggestionAdminMessagePayload(params: {
  status: 'pending' | 'published' | 'cancelled';
  channelTitle: string;
  authorAttribution: ChannelSuggestionAuthorAttribution;
  text: string;
  textFormat: BroadcastTextFormat;
  textMarkup: ChannelSuggestionTextMarkup[];
  reviewedBy: string | null;
  publishedUrl: string | null;
}): ChannelSuggestionMessagePayload {
  const hasMeaningfulText = params.text.trim().length > 0;
  const title =
    params.status === 'published'
      ? '✅ Предложка опубликована'
      : params.status === 'cancelled'
        ? '✖️ Предложка отклонена'
        : '📰 Новая предложка';
  const normalizedActorUserId = params.authorAttribution.userId.trim();
  const richTextHtml = hasMeaningfulText
    ? renderChannelSuggestionTextHtml(params.text, params.textMarkup, params.textFormat)
    : null;
  const publishedUrl = normalizeMaxProfileUrl(params.publishedUrl);

  if (richTextHtml) {
    const senderLine = renderChannelSuggestionAuthorLink(params.authorAttribution, 'html');

    return {
      text: [
        `<strong>${escapeHtml(title)}</strong>`,
        '',
        `Канал: ${escapeHtml(params.channelTitle)}`,
        `Отправитель: ${senderLine}`,
        ...(normalizedActorUserId
          ? [`MAX ID: <code>${escapeHtml(normalizedActorUserId)}</code>`]
          : []),
        ...(params.reviewedBy ? [`Решение принял: ${escapeHtml(params.reviewedBy)}`] : []),
        ...(publishedUrl
          ? [`Пост: <a href="${escapeHtmlAttribute(publishedUrl)}">Открыть пост</a>`]
          : []),
        '',
        '━━━━━━━━━━━━',
        '<strong>Контент публикации</strong>',
        richTextHtml,
      ].join('\n'),
      textFormat: 'html',
    };
  }

  const senderLine = renderChannelSuggestionAuthorLink(params.authorAttribution, 'markdown');
  return {
    text: [
      markdownTitle(title),
      '',
      `Канал: ${escapeMarkdown(params.channelTitle)}`,
      `Отправитель: ${senderLine}`,
      ...(normalizedActorUserId ? [`MAX ID: \`${escapeMarkdown(normalizedActorUserId)}\``] : []),
      ...(params.reviewedBy ? [`Решение принял: ${escapeMarkdown(params.reviewedBy)}`] : []),
      ...(publishedUrl ? [`Пост: [Открыть пост](${publishedUrl})`] : []),
      '',
      '━━━━━━━━━━━━',
      markdownTitle('Контент публикации'),
      ...(hasMeaningfulText
        ? [renderSuggestionTextForMarkdown(params.text, params.textFormat)]
        : ['_Медиа без подписи. Смотрите вложение выше._']),
    ].join('\n'),
    textFormat: 'markdown',
  };
}

export function buildPublishedChannelSuggestionMessagePayload(
  authorAttribution: ChannelSuggestionAuthorAttribution,
  suggestionText: string,
  textFormat: BroadcastTextFormat,
  textMarkup: ChannelSuggestionTextMarkup[],
): ChannelSuggestionMessagePayload {
  const hasMeaningfulSuggestionText = suggestionText.trim().length > 0;
  const richTextHtml = hasMeaningfulSuggestionText
    ? renderChannelSuggestionTextHtml(suggestionText, textMarkup, textFormat)
    : null;
  const format = richTextHtml ? 'html' : 'markdown';
  const attribution = `От подписчика ${renderChannelSuggestionAuthorLink(
    authorAttribution,
    format,
  )}`;

  if (richTextHtml) {
    return {
      text: hasMeaningfulSuggestionText ? `${attribution}\n\n${richTextHtml}` : attribution,
      textFormat: 'html',
    };
  }

  return {
    text: hasMeaningfulSuggestionText
      ? `${attribution}\n\n${renderSuggestionTextForMarkdown(suggestionText, textFormat)}`
      : attribution,
    textFormat: 'markdown',
  };
}
