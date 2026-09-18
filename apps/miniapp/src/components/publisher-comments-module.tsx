import type {
  PublisherChatCommentSettings,
  UpdatePublisherEntityModuleSettingsRequest,
} from '@maxim/contracts/publisher';
import { ChatBubble, InfoCircle, NavArrowRight } from 'iconoir-react';
import { lazy, Suspense, useId, useState } from 'react';
import { updatePublisherChatCommentSetting } from '../pages/publisher-entity-modules-page-model';

const LazySettingsDrilldownPanel = lazy(() =>
  import('./ui/settings-drilldown-panel').then((module) => ({
    default: module.SettingsDrilldownPanel,
  })),
);

const MODES = [
  {
    replace: false,
    label: 'Кнопка к сообщению',
    info: 'Публик отвечает на сообщение администратора кнопкой комментариев. Исходное сообщение остаётся от имени автора. MAX не позволяет боту добавлять кнопки прямо в чужое сообщение.',
  },
  {
    replace: true,
    label: 'От имени бота',
    info: 'Публик публикует копию сообщения администратора с кнопкой комментариев, затем удаляет оригинал. Если отправка не подтверждена, оригинал остаётся. Режим действует только на новые сообщения администраторов; посты Публика не дублируются.',
  },
] as const;

export function PublisherCommentsModule({
  chatComments,
  channelEnabled,
  entityTitle,
  pending,
  onChange,
}: {
  chatComments: PublisherChatCommentSettings | null;
  channelEnabled: boolean;
  entityTitle: string;
  pending: boolean;
  onChange: (change: Omit<UpdatePublisherEntityModuleSettingsRequest, 'expectedRevision'>) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState<{ label: string; info: string } | null>(null);
  const enabled = chatComments?.commentsEnabled ?? channelEnabled;
  const toggle = (key: keyof PublisherChatCommentSettings, value: boolean) => {
    if (chatComments) {
      onChange({ chatComments: updatePublisherChatCommentSetting(chatComments, key, value) });
    }
  };
  const switchControl = (
    label: string,
    checked: boolean,
    change: (value: boolean) => void,
    disabled = false,
  ) => (
    <label className="publisher-module-switch">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={pending || disabled}
        onChange={(event) => change(event.target.checked)}
      />
      <span className="publisher-module-switch__track" aria-hidden>
        <span className="publisher-module-switch__thumb" />
      </span>
    </label>
  );

  return (
    <section className="publisher-entity-module is-settings" data-publisher-module="comments">
      <button
        type="button"
        className="publisher-comments-toggle"
        aria-expanded={open}
        aria-controls={`${id}-settings`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="publisher-entity-module__icon is-comments" aria-hidden>
          <ChatBubble />
        </span>
        <span className="publisher-entity-module__copy">
          <strong>Комментарии</strong>
        </span>
        <NavArrowRight aria-hidden />
      </button>
      {open ? (
        <Suspense fallback={null}>
          <LazySettingsDrilldownPanel
            id={`${id}-workspace`}
            open
            title="Комментарии"
            summary={entityTitle}
            variant="screen"
            overlayClassName="publisher-comments-overlay publisher-comments-workspace-overlay"
            className="publisher-comments-dialog publisher-comments-workspace"
            headerAction={switchControl('Включить комментарии', enabled, (value) =>
              chatComments
                ? toggle('commentsEnabled', value)
                : onChange({ channelCommentsEnabled: value }),
            )}
            onClose={() => {
              setHint(null);
              setOpen(false);
            }}
          >
            <div id={`${id}-settings`}>
              <div className="publisher-entity-module__settings">
                {chatComments ? (
                  <>
                    <div className="publisher-entity-module__setting">
                      <span>Сообщения администраторов</span>
                      {switchControl(
                        'Комментарии для сообщений администраторов',
                        chatComments.commentsAdminsEnabled,
                        (value) => toggle('commentsAdminsEnabled', value),
                        !enabled,
                      )}
                    </div>
                    <fieldset className="publisher-comments-modes">
                      <legend className="publisher-comments-sr-only">Режим комментариев</legend>
                      {MODES.map((mode) => (
                        <div className="publisher-comments-mode" key={mode.label}>
                          <label>
                            <input
                              type="radio"
                              name={`${id}-mode`}
                              checked={
                                Boolean(chatComments.commentsReplaceOriginalEnabled) ===
                                mode.replace
                              }
                              disabled={pending || !enabled || !chatComments.commentsAdminsEnabled}
                              onChange={() =>
                                toggle('commentsReplaceOriginalEnabled', mode.replace)
                              }
                            />
                            <span>{mode.label}</span>
                          </label>
                          <button
                            type="button"
                            className="publisher-comments-info"
                            aria-label={`О режиме «${mode.label}»`}
                            title={`О режиме «${mode.label}»`}
                            aria-haspopup="dialog"
                            onClick={() => setHint(mode)}
                          >
                            <InfoCircle aria-hidden />
                          </button>
                        </div>
                      ))}
                    </fieldset>
                    <div className="publisher-entity-module__setting">
                      <span>Посты Публика</span>
                      {switchControl(
                        'Комментарии для постов Публика',
                        chatComments.commentsChatBroadcastsEnabled,
                        (value) => toggle('commentsChatBroadcastsEnabled', value),
                        !enabled,
                      )}
                    </div>
                  </>
                ) : (
                  <div className="publisher-entity-module__setting">
                    <span>Под постами канала</span>
                    <button
                      type="button"
                      className="publisher-comments-info"
                      aria-label="О комментариях канала"
                      title="О комментариях канала"
                      aria-haspopup="dialog"
                      onClick={() =>
                        setHint({
                          label: 'Комментарии канала',
                          info: 'Публик добавляет кнопку комментариев под новыми постами канала. Обсуждение открывается в мини-приложении.',
                        })
                      }
                    >
                      <InfoCircle aria-hidden />
                    </button>
                  </div>
                )}
              </div>
            </div>
          </LazySettingsDrilldownPanel>
        </Suspense>
      ) : null}
      {hint ? (
        <Suspense fallback={null}>
          <LazySettingsDrilldownPanel
            id={`${id}-info`}
            overlayClassName="publisher-comments-overlay"
            className="publisher-comments-dialog"
            open={hint !== null}
            title={hint?.label ?? 'Комментарии'}
            onClose={() => setHint(null)}
          >
            <p className="publisher-comments-help">{hint?.info}</p>
          </LazySettingsDrilldownPanel>
        </Suspense>
      ) : null}
    </section>
  );
}
