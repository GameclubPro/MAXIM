import {
  MANAGED_POLL_MESSAGE_MAX_LENGTH,
  MANAGED_POLL_QUESTION_MAX_LENGTH,
  type ManagedPollQuestionFormat,
} from '@maxim/contracts/poll';
import { renderSupportedMarkdownAsHtml, stripSupportedMarkdownToPlainText } from './max-markdown';
import { normalizeLegacyMultilineMarkdown } from './max-markdown-multiline';

export function validateManagedPollQuestion(
  value: string,
  format: ManagedPollQuestionFormat,
): string {
  const source = value.trim();
  const normalizedSource =
    format === 'markdown' ? normalizeLegacyMultilineMarkdown(source) : source;
  const plainText =
    format === 'markdown' ? stripSupportedMarkdownToPlainText(normalizedSource).trim() : source;

  if (!plainText) {
    return 'Введите вопрос.';
  }
  if (source.length > MANAGED_POLL_QUESTION_MAX_LENGTH) {
    return `Максимум ${MANAGED_POLL_QUESTION_MAX_LENGTH} символов.`;
  }
  if (
    format === 'markdown' &&
    renderSupportedMarkdownAsHtml(normalizedSource, { blockMode: 'raw' }).length >
      MANAGED_POLL_MESSAGE_MAX_LENGTH
  ) {
    return `После форматирования максимум ${MANAGED_POLL_MESSAGE_MAX_LENGTH} символов.`;
  }

  return '';
}
