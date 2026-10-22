import { useEffect, useState } from 'react';
import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import type {
  ChatSettingsFieldAdapter,
  ChatSettingsFieldValues,
} from '../../features/network-settings/field-model';
import type { ChatBooleanField } from '../../features/network-settings/chat-field-intents';
import type { ApiTransport } from '../../lib/api/transport';
import { BroadcastLinkButtonsEditor } from '../../components/broadcast-link-buttons-editor';
import {
  createEmptyBroadcastLinkButton,
  validateBroadcastLinkButtons,
} from '../../lib/broadcast-link-buttons';
import { FieldList } from '../../features/network-settings/settings-field-controls';
import { SharedNativeSettingsToggle } from './shared-native-settings-toggle';

type ButtonPath = {
  [K in keyof ChatSettingsFieldValues]: ChatSettingsFieldValues[K] extends BroadcastLinkButton[]
    ? K
    : never;
}[keyof ChatSettingsFieldValues] &
  string;
export function SharedBotButtonsFields({
  fields,
  api,
  path,
  enabledPath,
  activationLabel = 'Добавить кнопку',
  urlPlaceholder = 'https://max.ru/channel/...',
}: {
  fields: ChatSettingsFieldAdapter;
  api: ApiTransport;
  path: ButtonPath;
  enabledPath: ChatBooleanField;
  activationLabel?: string;
  urlPlaceholder?: string;
}) {
  const enabled = fields.read(enabledPath);
  const state = fields.read(path);
  const replace = (items: BroadcastLinkButton[]) => {
    try {
      fields.transact([
        { op: 'replace', path, value: items },
        { op: 'set', path: enabledPath, value: items.length > 0 },
      ]);
      fields.setError(path, null);
    } catch {
      fields.setError(path, 'Заполните название и ссылку каждой кнопки.');
    }
  };
  return (
    <SharedNativeSettingsToggle
      state={enabled}
      title="Добавить кнопку"
      label={activationLabel}
      disabled={fields.readOnly}
      nested
      onChange={(next) => {
        fields.setScalar(enabledPath, next);
        fields.setError(
          path,
          next && state.kind === 'common' && state.value.length === 0
            ? 'Заполните название и ссылку кнопки.'
            : null,
        );
      }}
    >
      {enabled.kind !== 'common' || enabled.value || fields.error(path) ? (
        state.kind === 'common' ? (
          <ButtonListDraft
            api={api}
            fields={fields}
            path={path}
            items={state.value}
            replace={replace}
            urlPlaceholder={urlPlaceholder}
          />
        ) : (
          <FieldList<BroadcastLinkButton>
            label="Кнопки сообщения"
            state={state}
            disabled={fields.readOnly}
            error={fields.error(path)}
            onChange={replace}
          >
            {(items, onReplace) => (
              <ButtonListDraft
                api={api}
                fields={fields}
                path={path}
                items={items}
                replace={onReplace}
                urlPlaceholder={urlPlaceholder}
              />
            )}
          </FieldList>
        )
      ) : null}
      {fields.error(path) ? (
        <p className="field__hint" role="alert">
          {fields.error(path)}
        </p>
      ) : null}
    </SharedNativeSettingsToggle>
  );
}
function ButtonListDraft({
  api,
  fields,
  path,
  items,
  replace,
  urlPlaceholder,
}: {
  api: ApiTransport;
  fields: ChatSettingsFieldAdapter;
  path: ButtonPath;
  items: BroadcastLinkButton[];
  replace: (items: BroadcastLinkButton[]) => void;
  urlPlaceholder: string;
}) {
  const [buffer, setBuffer] = useState<BroadcastLinkButton[] | null>(() =>
    items.length ? null : [createEmptyBroadcastLinkButton()],
  );
  const incoming = JSON.stringify(items);
  useEffect(() => setBuffer(items.length ? null : [createEmptyBroadcastLinkButton()]), [incoming]);
  const buttons = buffer ?? items;
  return (
    <BroadcastLinkButtonsEditor
      api={api}
      buttons={buttons}
      errors={fields.error(path) ? validateBroadcastLinkButtons(buttons) : []}
      disabled={fields.readOnly}
      title="Кнопки сообщения"
      subtitle="Название и ссылка"
      urlPlaceholder={urlPlaceholder}
      textPlaceholder="Открыть"
      onChange={(next) => {
        setBuffer(next);
        if (validateBroadcastLinkButtons(next).some((error) => Object.keys(error).length > 0)) {
          fields.setError(path, 'Заполните название и ссылку каждой кнопки.');
          return;
        }
        replace(next);
      }}
    />
  );
}
