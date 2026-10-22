import { Suspense } from 'react';
import { resolveBotSpeechStyle } from '@maxim/contracts/bot-speech';
import type { ChatSettingsFieldAdapter } from '../../features/network-settings/field-model';
import type { ApiTransport } from '../../lib/api/transport';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { SharedSpeechStyleFieldsProps } from './shared-speech-style-fields';
import {
  SharedMessageRetentionFields,
  SharedMessageRetentionExclusions,
} from './shared-message-retention-fields';
import { SharedAdvertisingFields } from './shared-advertising-fields';
import type { SharedChatSettingsContext } from './shared-chat-settings-section';

const SpeechStyleFields = recoverableLazyNamedComponent<SharedSpeechStyleFieldsProps>(
  () => import('./shared-speech-style-fields'),
  'SharedSpeechStyleFields',
);
const RulesFields = recoverableLazyNamedComponent<{
  fields: ChatSettingsFieldAdapter;
  api?: ApiTransport;
  context?: SharedChatSettingsContext;
}>(() => import('./shared-network-rules-fields'), 'SharedNetworkRulesFields');

export type SupplementaryChatSettingsSection =
  | 'speechStyle'
  | 'rules'
  | 'messageRetention'
  | 'advertising';
export type SharedSupplementaryChatSettingsFieldsProps = {
  section: SupplementaryChatSettingsSection;
  fields: ChatSettingsFieldAdapter;
  api?: ApiTransport;
  context?: SharedChatSettingsContext;
};

export function SharedSupplementaryChatSettingsFields({
  section,
  fields,
  api,
  context,
}: SharedSupplementaryChatSettingsFieldsProps) {
  if (section === 'speechStyle') {
    const state = fields.read('botSpeechStyle');
    return (
      <Suspense fallback={null}>
        <SpeechStyleFields
          selectedStyle={state.kind === 'common' ? resolveBotSpeechStyle(state.value) : null}
          disabled={fields.readOnly || state.kind === 'loading'}
          emptyMessage={state.kind === 'loading' ? 'Загрузка…' : undefined}
          onSelect={(style) => fields.setScalar('botSpeechStyle', style)}
        />
      </Suspense>
    );
  }
  if (section === 'messageRetention')
    return (
      <div className="message-retention-settings">
        <SharedMessageRetentionFields
          enabled={fields.read('messageRetention.enabled')}
          hours={fields.read('messageRetention.hours')}
          disabled={fields.readOnly}
          onEnabledChange={(enabled) => fields.setScalar('messageRetention.enabled', enabled)}
          onHoursChange={(hours) => fields.setScalar('messageRetention.hours', hours)}
        />
        <SharedMessageRetentionExclusions />
      </div>
    );
  if (section === 'advertising')
    return (
      <div className="advertising-workspace">
        <SharedAdvertisingFields
          enabled={fields.read('advertising.enabled')}
          disabled={fields.readOnly}
          onChange={(enabled) => fields.setScalar('advertising.enabled', enabled)}
        />
        <p className="advertising-workspace__note">
          Выключение не удаляет уже отправленную кнопку.
        </p>
      </div>
    );
  return (
    <Suspense fallback={null}>
      <RulesFields fields={fields} api={context?.api ?? api} context={context} />
    </Suspense>
  );
}
