import { Suspense, useState, type ComponentProps } from 'react';
import { MAX_CHAT_RULES_TEXT_LENGTH } from '@maxim/contracts/settings';
import type { BroadcastContentComposerProps } from '../../components/broadcast-content-composer';
import type { BroadcastButtonsSheet } from '../../components/broadcast-buttons-sheet';
import {
  BroadcastStudioHeader,
  type BroadcastStudioSignal,
} from '../../components/broadcast-studio-header';
import type {
  ChatSettingsFieldAdapter,
  SettingsFieldState,
} from '../../features/network-settings/field-model';
import type { ApiTransport } from '../../lib/api/transport';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import {
  hasBroadcastLinkButtonErrors,
  validateBroadcastLinkButtons,
  formatBroadcastButtonsStatus,
} from '../../lib/broadcast-link-buttons';
import { SharedRulesSettingsStudio } from './shared-rules-settings-studio';
import type { SharedChatSettingsContext } from './shared-chat-settings-section';

const Composer = recoverableLazyNamedComponent<BroadcastContentComposerProps>(
  () => import('../../components/broadcast-content-composer'),
  'BroadcastContentComposer',
);
const ButtonsSheet = recoverableLazyNamedComponent<ComponentProps<typeof BroadcastButtonsSheet>>(
  () => import('../../components/broadcast-buttons-sheet'),
  'BroadcastButtonsSheet',
);

function common<T>(state: SettingsFieldState<T>, fallback: T): T {
  return state.kind === 'common' ? state.value : fallback;
}

export function SharedNetworkRulesFields({
  fields,
  api,
  context,
}: {
  fields: ChatSettingsFieldAdapter;
  api?: ApiTransport;
  context?: SharedChatSettingsContext;
}) {
  const [buttonsOpen, setButtonsOpen] = useState(false);
  const [buttonsReplacementRequested, setButtonsReplacementRequested] = useState(false);
  const [buttonsMixedNotice, setButtonsMixedNotice] = useState(false);
  const text = fields.read('rules.text');
  const format = fields.read('rules.textFormat');
  const autoText = fields.read('rules.autoTextEnabled');
  const imageBase64 = fields.read('rules.imageBase64');
  const imageMimeType = fields.read('rules.imageMimeType');
  const imageFileName = fields.read('rules.imageFileName');
  const buttonState = fields.read('rules.buttons');
  const buttonEnabled = fields.read('rules.buttonEnabled');
  const buttons = common(buttonState, []);
  const buttonsValid = !hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(buttons));
  const imageMixed = [imageBase64, imageMimeType, imageFileName].some(
    (state) => state.kind === 'mixed',
  );
  const imageLoading = [imageBase64, imageMimeType, imageFileName].some(
    (state) => state.kind === 'loading',
  );
  const base64 = common(imageBase64, '');
  const mimeType = common(imageMimeType, '');
  const fileName = common(imageFileName, '');
  const hasContent = Boolean(common(text, '').trim() || common(autoText, false));
  const buttonsMixed = buttonState.kind === 'mixed' || buttonEnabled.kind === 'mixed';
  const busy =
    fields.readOnly || text.kind === 'loading' || format.kind === 'loading' || imageLoading;
  const contentMixed = text.kind === 'mixed' || autoText.kind === 'mixed';
  const hasImage = Boolean(base64 && mimeType) && !imageMixed;
  const imageReady = !imageLoading && !fields.error('rules.imageBase64') && (!base64 || hasImage);
  const buttonStatus = buttonsMixed
    ? 'Разные значения'
    : common(buttonEnabled, false)
      ? formatBroadcastButtonsStatus(buttons)
      : 'Без кнопок';
  const signals: BroadcastStudioSignal[] = [
    {
      label: 'Текст',
      value: contentMixed
        ? 'Разные значения'
        : common(autoText, false)
          ? 'Авто'
          : common(text, '').trim()
            ? String(common(text, '').trim().length) + '/' + MAX_CHAT_RULES_TEXT_LENGTH
            : 'Пусто',
      tone: contentMixed ? 'neutral' : hasContent ? 'ready' : 'pending',
      icon: 'content',
    },
    {
      label: 'Фото',
      value: imageMixed ? 'Разные значения' : imageLoading ? 'Загрузка' : hasImage ? 'Есть' : 'Нет',
      tone: imageMixed ? 'neutral' : hasImage ? 'ready' : imageReady ? 'neutral' : 'pending',
      icon: 'content',
    },
    {
      label: 'Кнопки',
      value: buttonStatus,
      tone: buttonsMixed
        ? 'neutral'
        : buttonsValid
          ? common(buttonEnabled, false)
            ? 'ready'
            : 'neutral'
          : 'danger',
      icon: 'button',
    },
    { label: 'Публикация', value: 'Отдельное действие', tone: 'neutral', icon: 'channel' },
  ];
  const clearImage = () =>
    fields.transact([
      { op: 'set', path: 'rules.imageBase64', value: '' },
      { op: 'set', path: 'rules.imageMimeType', value: '' },
      { op: 'set', path: 'rules.imageFileName', value: '' },
    ]);
  return (
    <>
      <SharedRulesSettingsStudio
        header={
          <BroadcastStudioHeader
            title="Пост правил"
            subtitle={
              text.kind === 'mixed' ? 'Разные тексты' : hasContent ? 'Черновик' : 'Пустой черновик'
            }
            readyCount={[hasContent, imageReady, buttonsValid].filter(Boolean).length}
            totalCount={signals.length}
            signals={signals}
            busy={busy}
            ariaLabel="Сводка правил"
          />
        }
        hasContent={hasContent}
        contentStatus={contentMixed ? 'Разные значения' : undefined}
        beforeComposer={
          <>
            {text.kind === 'mixed' ? (
              <p className="field__hint" role="status">
                Тексты различаются. Ввод заменит текст правил в выбранных чатах.
              </p>
            ) : null}
            {imageMixed ? (
              <p className="field__hint" role="status">
                Изображения различаются. Выбор новой картинки заменит изображения правил.
              </p>
            ) : null}
            {imageMixed ? (
              <button
                type="button"
                className="button button--ghost"
                disabled={busy}
                onClick={clearImage}
              >
                Удалить изображения правил
              </button>
            ) : null}
            {buttonsMixedNotice ? (
              <div className="settings-native-toggle" role="status">
                <p className="field__hint">
                  Кнопки различаются. Для замены составьте общий список.
                </p>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={busy || !api}
                  onClick={() => {
                    setButtonsReplacementRequested(true);
                    setButtonsMixedNotice(false);
                    setButtonsOpen(true);
                  }}
                >
                  Составить общий список кнопок
                </button>
              </div>
            ) : null}
          </>
        }
        composer={
          <Suspense fallback={null}>
            <Composer
              className="rules-content-composer"
              text={common(text, '')}
              sourceFormat={common(format, 'markdown')}
              maxLength={MAX_CHAT_RULES_TEXT_LENGTH}
              image={{
                enabled: Boolean(base64 && mimeType) && !imageMixed,
                base64,
                mimeType,
                fileName,
              }}
              disabled={busy}
              textError={fields.error('rules.text') ?? undefined}
              imageError={fields.error('rules.imageBase64') ?? undefined}
              onImagePreparationChange={(preparing) =>
                fields.setError('rules.imageBase64', preparing ? 'Подготовка изображения…' : null)
              }
              messageAriaLabel="Пост правил"
              textPlaceholder={
                text.kind === 'mixed' ? 'Разные тексты. Введите общий текст правил' : 'Текст правил'
              }
              textAriaLabel="Текст правил"
              onTextChange={(value) => {
                fields.setError('rules.text', null);
                fields.transact([
                  { op: 'set', path: 'rules.text', value },
                  { op: 'set', path: 'rules.textFormat', value: 'markdown' },
                  { op: 'set', path: 'rules.autoTextEnabled', value: false },
                ]);
              }}
              onImageChange={(image) => {
                fields.setError('rules.imageBase64', null);
                fields.transact([
                  {
                    op: 'set',
                    path: 'rules.imageBase64',
                    value: image.enabled ? image.base64 : '',
                  },
                  {
                    op: 'set',
                    path: 'rules.imageMimeType',
                    value: image.enabled ? image.mimeType : '',
                  },
                  {
                    op: 'set',
                    path: 'rules.imageFileName',
                    value: image.enabled ? image.fileName : '',
                  },
                ]);
              }}
              onError={(message) => fields.setError('rules.imageBase64', message)}
              buttons={buttons}
              buttonsStatusLabel={buttonStatus}
              buttonsActive={buttonEnabled.kind === 'common' && buttonEnabled.value}
              buttonsError={!buttonsValid}
              onOpenButtons={() => {
                if (!api) return;
                if (buttonsMixed && !buttonsReplacementRequested) setButtonsMixedNotice(true);
                else setButtonsOpen(true);
              }}
            />
          </Suspense>
        }
        autoText={autoText}
        disabled={busy}
        onAutoTextChange={(enabled) => fields.setScalar('rules.autoTextEnabled', enabled)}
        adminContact={context?.renderAdminContact?.({
          enabledPath: 'rules.adminContactButtonEnabled',
          urlPath: 'rules.adminContactButtonUrl',
          label: 'Связь с админом',
          ariaLabel: 'Добавить связь с админом в пост правил',
          presentation: 'rules',
        })}
        attachViolations={fields.read('rulesAttachViolationsEnabled')}
        attachDisabled={fields.readOnly}
        onAttachViolationsChange={(enabled) =>
          fields.setScalar('rulesAttachViolationsEnabled', enabled)
        }
      />
      {api ? (
        <Suspense fallback={null}>
          <ButtonsSheet
            open={buttonsOpen}
            api={api}
            enabled={buttonEnabled.kind === 'common' && buttonEnabled.value}
            buttons={buttons}
            errors={validateBroadcastLinkButtons(buttons)}
            disabled={busy}
            urlPlaceholder="https://max.ru/channel/rules"
            textPlaceholder="Правила"
            onEnabledChange={(enabled) => fields.setScalar('rules.buttonEnabled', enabled)}
            onChange={(value) =>
              fields.transact([
                { op: 'replace', path: 'rules.buttons', value },
                { op: 'set', path: 'rules.buttonEnabled', value: value.length > 0 },
              ])
            }
            onClose={() => setButtonsOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
