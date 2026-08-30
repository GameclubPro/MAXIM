import { stripSupportedMarkdownToPlainText } from '../common/max-markdown.util';
import { escapePrivateMarkdown } from './private-control-launcher-renderer';

const PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH = 3_200;
const PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX = '\n\n_Показан фрагмент. Полный текст сохранён._';

export function buildPrivateRulesScreenTextPreview(text: string): string {
  if (text.length <= PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH) {
    return text;
  }

  const plainText = stripSupportedMarkdownToPlainText(text).trim() || text.trim();
  const ellipsis = '…';
  const escapedTextBudget =
    PRIVATE_RULES_SCREEN_PREVIEW_MAX_LENGTH -
    PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX.length -
    ellipsis.length;
  let escapedPreview = '';

  for (const character of plainText) {
    const escapedCharacter = escapePrivateMarkdown(character);
    if (escapedPreview.length + escapedCharacter.length > escapedTextBudget) {
      break;
    }
    escapedPreview += escapedCharacter;
  }

  return `${escapedPreview.trimEnd()}${ellipsis}${PRIVATE_RULES_SCREEN_PREVIEW_SUFFIX}`;
}
