import type { BroadcastTextFormat } from '@maxim/contracts';
import { stripSupportedMarkdownToPlainText } from '../common/max-markdown.util';

const PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH = 3_200;
const PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX = '\n\n_Показан фрагмент. Полный текст сохранён._';

function escapePrivateRulesPlainText(value: string): string {
  return value.replace(/([\\`#^>*_[\]()~+])/gu, '\\$1');
}

export function buildPrivateRulesScreenTextPreview(
  text: string,
  textFormat: BroadcastTextFormat = 'markdown',
): string {
  if (text.length <= PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH) {
    return textFormat === 'markdown' ? text : escapePrivateRulesPlainText(text);
  }

  const plainText =
    (textFormat === 'markdown' ? stripSupportedMarkdownToPlainText(text) : text).trim() ||
    text.trim();
  const ellipsis = '…';
  const escapedTextBudget =
    PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH -
    PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX.length -
    ellipsis.length;
  let escapedPreview = '';

  for (const character of plainText) {
    const escapedCharacter = escapePrivateRulesPlainText(character);
    if (escapedPreview.length + escapedCharacter.length > escapedTextBudget) {
      break;
    }
    escapedPreview += escapedCharacter;
  }

  return `${escapedPreview.trimEnd()}${ellipsis}${PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX}`;
}
