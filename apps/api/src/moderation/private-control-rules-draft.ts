import type { ChatRules, UpdateChatRulesRequest } from '@maxim/contracts';

type PrivateChatRulesDraft = Pick<
  ChatRules,
  | 'text'
  | 'textFormat'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'autoTextEnabled'
  | 'buttons'
  | 'buttonEnabled'
  | 'buttonUrl'
  | 'buttonText'
  | 'adminContactButtonEnabled'
  | 'adminContactButtonUrl'
>;

export function buildPrivateChatRulesDraft(
  current: PrivateChatRulesDraft,
  overrides: Partial<PrivateChatRulesDraft>,
): UpdateChatRulesRequest {
  return {
    text: current.text,
    textFormat: current.textFormat,
    imageBase64: current.imageBase64,
    imageMimeType: current.imageMimeType,
    imageFileName: current.imageFileName,
    autoTextEnabled: current.autoTextEnabled,
    buttons: current.buttons,
    buttonEnabled: current.buttonEnabled,
    buttonUrl: current.buttonUrl,
    buttonText: current.buttonText,
    adminContactButtonEnabled: current.adminContactButtonEnabled,
    adminContactButtonUrl: current.adminContactButtonUrl,
    ...overrides,
  };
}
