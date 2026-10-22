import {
  botSpeechMediaSchema,
  channelSettingsSchema,
  chatSettingsFieldsSchema,
  stopWordsPolicySchema,
  chatRulesFieldsSchema,
  messageRetentionHoursSchema,
} from '@maxim/contracts/settings-field-schemas';
import { channelPostSignatureSettingsSchema } from '@maxim/contracts/channel-post-signature';
import type { NetworkSettingsSection } from '@maxim/contracts/network-settings';
import { settingsSectionPaths } from './field-paths';

export { CHAT_SECTION_FIELDS, CHANNEL_SECTION_FIELDS, settingsSectionPaths } from './field-paths';

type ValueSchema = {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { message: string }[] } };
};
export function settingsFieldSchema(
  entityType: 'chat' | 'channel',
  section: NetworkSettingsSection,
  path: string,
): ValueSchema {
  if (!settingsSectionPaths(entityType, section).includes(path))
    throw new Error('Поле не входит в раздел.');
  if (entityType === 'channel') {
    const shape =
      section === 'postSignature'
        ? channelPostSignatureSettingsSchema.shape
        : channelSettingsSchema.shape;
    return shape[path as keyof typeof shape] as ValueSchema;
  }
  if (path.startsWith('rules.'))
    return chatRulesFieldsSchema.shape[
      path.slice('rules.'.length) as keyof typeof chatRulesFieldsSchema.shape
    ] as ValueSchema;
  if (path === 'messageRetention.hours') return messageRetentionHoursSchema;
  if (path === 'messageRetention.enabled' || path === 'advertising.enabled')
    return chatSettingsFieldsSchema.shape.reportsEnabled;
  if (path.startsWith('botSpeechMedia.')) return botSpeechMediaSchema.unwrap().valueType.nullable();
  if (path.startsWith('stopWordsPolicy.')) {
    const keys = path.split('.').slice(1);
    if (keys[0] !== 'sanctions')
      return stopWordsPolicySchema.shape[keys[0] as 'enabled'] as ValueSchema;
    const sanctions = stopWordsPolicySchema.shape.sanctions.unwrap().shape;
    if (keys[1] === 'media')
      return sanctions.media.unwrap().shape[keys[2] as 'explanation'].nullable();
    return sanctions[keys[1] as 'botMessageText'] as ValueSchema;
  }
  return chatSettingsFieldsSchema.shape[
    path as keyof typeof chatSettingsFieldsSchema.shape
  ] as ValueSchema;
}
export function parseSettingsField(
  entityType: 'chat' | 'channel',
  section: NetworkSettingsSection,
  path: string,
  value: unknown,
): unknown {
  // FLAG: A missing common value is a protocol error, never permission to manufacture defaults.
  if (value === undefined) throw new Error('Значение поля отсутствует.');
  const result = settingsFieldSchema(entityType, section, path).safeParse(value);
  if (!result.success)
    throw new Error(result.error.issues[0]?.message ?? 'Недопустимое значение поля.');
  return result.data;
}
