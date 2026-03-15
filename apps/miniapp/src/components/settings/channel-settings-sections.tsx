import type { ChannelSettings } from '@maxim/contracts';
import type { ReactElement } from 'react';
import { cn } from '../../lib/cn';

type ChannelSettingsHintKey =
  | 'commentsEnabled'
  | 'commentsModerationEnabled'
  | 'commentsBlockLinksEnabled'
  | 'commentsAntiSpamEnabled'
  | 'commentsLimitTwoInRowEnabled'
  | 'postSuggestionsEnabled'
  | 'engagementMessageText'
  | 'publishEngagement'
  | 'broadcastText'
  | 'broadcastImage'
  | 'broadcastButton';

type RenderChannelSettingsHintAnchor = (props: {
  hintKey: ChannelSettingsHintKey;
  label: string;
  children: string;
}) => ReactElement;

type RenderChannelSettingsToggleCard = (props: {
  title: string;
  description?: string;
  hintKey?: ChannelSettingsHintKey;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
  disabled?: boolean;
}) => ReactElement;

type CommentsBooleanField =
  | 'commentsEnabled'
  | 'commentsModerationEnabled'
  | 'commentsBlockLinksEnabled'
  | 'commentsAntiSpamEnabled'
  | 'commentsLimitTwoInRowEnabled';

type PostSuggestionsField =
  | 'postSuggestionsEnabled'
  | 'engagementMessageText'
  | 'postSuggestionsButtonText'
  | 'postSuggestionsText';

export function ChannelCommentsSectionContent({
  draft,
  renderToggleCard,
  patchField,
}: {
  draft: ChannelSettings;
  renderToggleCard: RenderChannelSettingsToggleCard;
  patchField: (field: CommentsBooleanField, value: boolean) => void;
}) {
  return (
    <>
      {renderToggleCard({
        title: 'Включить комментарии',
        description: 'Обсуждение под постами.',
        hintKey: 'commentsEnabled',
        checked: draft.commentsEnabled,
        onChange: (nextValue) => patchField('commentsEnabled', nextValue),
      })}

      {draft.commentsEnabled ? (
        <div className="channel-settings-stack">
          <div
            id="channel-settings-detail-comments-moderation"
            className="settings-detail-anchor"
          />
          {renderToggleCard({
            title: 'Модерация',
            description: 'Проверка комментариев.',
            hintKey: 'commentsModerationEnabled',
            checked: draft.commentsModerationEnabled,
            onChange: (nextValue) => patchField('commentsModerationEnabled', nextValue),
          })}

          {draft.commentsModerationEnabled ? (
            <div className="channel-settings-stack">
              {renderToggleCard({
                title: 'Запретить ссылки',
                description: 'Ссылки в комментариях блокируются.',
                hintKey: 'commentsBlockLinksEnabled',
                checked: draft.commentsBlockLinksEnabled,
                onChange: (nextValue) => patchField('commentsBlockLinksEnabled', nextValue),
              })}

              {renderToggleCard({
                title: 'Антиспам',
                description: 'Блок частых повторов.',
                hintKey: 'commentsAntiSpamEnabled',
                checked: draft.commentsAntiSpamEnabled,
                onChange: (nextValue) => patchField('commentsAntiSpamEnabled', nextValue),
              })}

              {renderToggleCard({
                title: 'Не больше двух подряд',
                description: 'Третий подряд блокируется.',
                hintKey: 'commentsLimitTwoInRowEnabled',
                checked: draft.commentsLimitTwoInRowEnabled,
                onChange: (nextValue) => patchField('commentsLimitTwoInRowEnabled', nextValue),
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function ChannelPostSuggestionsSectionContent({
  draft,
  publishHint,
  canPublishEngagement,
  publishPending,
  onPublish,
  renderHintAnchor,
  renderToggleCard,
  patchField,
}: {
  draft: ChannelSettings;
  publishHint: string;
  canPublishEngagement: boolean;
  publishPending: boolean;
  onPublish: () => void;
  renderHintAnchor: RenderChannelSettingsHintAnchor;
  renderToggleCard: RenderChannelSettingsToggleCard;
  patchField: <K extends PostSuggestionsField>(field: K, value: ChannelSettings[K]) => void;
}) {
  return (
    <>
      {renderToggleCard({
        title: 'Разрешить предложения',
        description: 'Кнопка предложки под новыми постами.',
        hintKey: 'postSuggestionsEnabled',
        checked: draft.postSuggestionsEnabled,
        onChange: (nextValue) => patchField('postSuggestionsEnabled', nextValue),
      })}

      <div className="channel-settings-stack">
        <div id="channel-settings-detail-suggest-publish" className="settings-detail-anchor" />
        <label className="field">
          <div className="channel-settings-field-label">
            <span>Текст публикации</span>
            {renderHintAnchor({
              hintKey: 'engagementMessageText',
              label: 'Пояснение для текста публикации',
              children: 'Текст поста перед кнопками.',
            })}
          </div>
          <textarea
            rows={3}
            value={draft.engagementMessageText}
            onChange={(event) => patchField('engagementMessageText', event.target.value)}
            placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
          />
        </label>

        <label className="field">
          <span>Название кнопки</span>
          <input
            type="text"
            value={draft.postSuggestionsButtonText}
            onChange={(event) => patchField('postSuggestionsButtonText', event.target.value)}
            placeholder="Предложить пост"
            maxLength={32}
          />
        </label>

        <label className="field">
          <span>Текст</span>
          <textarea
            rows={3}
            value={draft.postSuggestionsText}
            onChange={(event) => patchField('postSuggestionsText', event.target.value)}
            placeholder="Коротко объясните, что отправлять."
          />
        </label>

        <div className="channel-settings-inline-fields">
          <label className="field">
            <div className="channel-settings-field-label">
              <span>Пост с кнопками</span>
              {renderHintAnchor({
                hintKey: 'publishEngagement',
                label: 'Пояснение для поста с кнопками',
                children: publishHint,
              })}
            </div>
          </label>
          <button
            type="button"
            className="button button--accent"
            onClick={onPublish}
            disabled={!canPublishEngagement || publishPending}
          >
            {publishPending ? 'Публикуем…' : 'Опубликовать или обновить'}
          </button>
        </div>
      </div>
    </>
  );
}

export function ChannelBroadcastSectionContent({
  renderHintAnchor,
  broadcastButtonEnabled,
  setBroadcastButtonEnabled,
  broadcastButtonUrl,
  setBroadcastButtonUrl,
  broadcastButtonText,
  setBroadcastButtonText,
  broadcastButtonUrlError,
  broadcastButtonTextError,
  broadcastScheduleEnabled,
  setBroadcastScheduleEnabled,
  broadcastScheduleDays,
  setBroadcastScheduleDays,
  broadcastScheduleTime,
  setBroadcastScheduleTime,
  broadcastScheduleError,
  broadcastSchedulePreview,
  broadcastCycleEnabled,
  setBroadcastCycleEnabled,
  broadcastCycleEveryHours,
  setBroadcastCycleEveryHours,
  broadcastCycleCount,
  setBroadcastCycleCount,
  broadcastCycleError,
  minCycleHours,
  maxCycleHours,
  maxCycleCount,
  maxScheduleDays,
  onSend,
  onReset,
  isSending,
}: {
  renderHintAnchor: RenderChannelSettingsHintAnchor;
  broadcastButtonEnabled: boolean;
  setBroadcastButtonEnabled: (value: boolean) => void;
  broadcastButtonUrl: string;
  setBroadcastButtonUrl: (value: string) => void;
  broadcastButtonText: string;
  setBroadcastButtonText: (value: string) => void;
  broadcastButtonUrlError: string;
  broadcastButtonTextError: string;
  broadcastScheduleEnabled: boolean;
  setBroadcastScheduleEnabled: (value: boolean) => void;
  broadcastScheduleDays: number;
  setBroadcastScheduleDays: (value: number) => void;
  broadcastScheduleTime: string;
  setBroadcastScheduleTime: (value: string) => void;
  broadcastScheduleError: string;
  broadcastSchedulePreview: string;
  broadcastCycleEnabled: boolean;
  setBroadcastCycleEnabled: (value: boolean) => void;
  broadcastCycleEveryHours: number;
  setBroadcastCycleEveryHours: (value: number) => void;
  broadcastCycleCount: number;
  setBroadcastCycleCount: (value: number) => void;
  broadcastCycleError: string;
  minCycleHours: number;
  maxCycleHours: number;
  maxCycleCount: number;
  maxScheduleDays: number;
  onSend: () => void;
  onReset: () => void;
  isSending: boolean;
}) {
  return (
    <div className="channel-broadcast-studio">
      <div className="mailing-options-grid">
        <div className="managed-broadcast-editor-note">
          <strong>Контент в боте</strong>
          <small>Текст и фото отправляются в личке бота.</small>
        </div>

        <div
          className={cn(
            'mailing-option-card',
            broadcastButtonEnabled && 'is-enabled',
            (broadcastButtonUrlError || broadcastButtonTextError) && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="channel-settings-field-label">
                <span className="mailing-option-card__title">Кнопка</span>
                {renderHintAnchor({
                  hintKey: 'broadcastButton',
                  label: 'Пояснение для кнопки в рассылке',
                  children: 'Кнопка для перехода в канал, пост или ссылку.',
                })}
              </div>
              <small className="mailing-option-card__subtitle">
                {broadcastButtonEnabled ? 'CTA включён' : 'Необязательно'}
              </small>
            </div>

            <label className="settings-native-switch" aria-label="Добавить кнопку в пост канала">
              <input
                type="checkbox"
                checked={broadcastButtonEnabled}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setBroadcastButtonEnabled(enabled);
                }}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {broadcastButtonEnabled ? (
            <div className="mailing-option-card__body">
              <label
                className={cn(
                  'field settings-url-field',
                  broadcastButtonUrlError && 'field--error',
                )}
              >
                <span className="field__label">Ссылка кнопки</span>
                <input
                  type="url"
                  inputMode="url"
                  value={broadcastButtonUrl}
                  onChange={(event) => setBroadcastButtonUrl(event.target.value)}
                  placeholder="https://max.ru/channel/..."
                />
                {broadcastButtonUrlError ? (
                  <small className="field__hint">{broadcastButtonUrlError}</small>
                ) : null}
              </label>

              <label
                className={cn(
                  'field settings-text-field',
                  broadcastButtonTextError && 'field--error',
                )}
              >
                <span className="field__label">Название кнопки</span>
                <input
                  type="text"
                  maxLength={32}
                  value={broadcastButtonText}
                  onChange={(event) => setBroadcastButtonText(event.target.value)}
                  placeholder="Открыть"
                />
                {broadcastButtonTextError ? (
                  <small className="field__hint">{broadcastButtonTextError}</small>
                ) : null}
              </label>
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            'mailing-option-card',
            broadcastScheduleEnabled && 'is-enabled',
            broadcastScheduleError && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="channel-settings-field-label">
                <span className="mailing-option-card__title">Таймер</span>
                {renderHintAnchor({
                  hintKey: 'broadcastText',
                  label: 'Пояснение для таймера рассылки',
                  children: 'Можно отложить пост в канал максимум на 14 дней.',
                })}
              </div>
              <small className="mailing-option-card__subtitle">
                {broadcastScheduleEnabled && broadcastSchedulePreview
                  ? broadcastSchedulePreview
                  : 'Отправка сразу'}
              </small>
            </div>

            <label
              className="settings-native-switch"
              aria-label="Включить таймер для рассылки в канал"
            >
              <input
                type="checkbox"
                checked={broadcastScheduleEnabled}
                onChange={(event) => setBroadcastScheduleEnabled(event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {broadcastScheduleEnabled ? (
            <div className="mailing-option-card__body">
              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Через дней</span>
                <input
                  type="number"
                  min={0}
                  max={maxScheduleDays}
                  value={broadcastScheduleDays}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    setBroadcastScheduleDays(
                      Number.isNaN(nextValue)
                        ? 0
                        : Math.max(0, Math.min(maxScheduleDays, nextValue)),
                    );
                  }}
                />
              </label>

              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Время</span>
                <input
                  type="time"
                  value={broadcastScheduleTime}
                  onChange={(event) => setBroadcastScheduleTime(event.target.value)}
                />
              </label>

              {broadcastScheduleError ? (
                <small className="field__hint">{broadcastScheduleError}</small>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          className={cn(
            'mailing-option-card',
            broadcastCycleEnabled && 'is-enabled',
            broadcastCycleError && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="channel-settings-field-label">
                <span className="mailing-option-card__title">Цикл</span>
                {renderHintAnchor({
                  hintKey: 'broadcastImage',
                  label: 'Пояснение для цикла рассылки',
                  children:
                    'Повторяет отправку в канал через заданный интервал. Общая длина цикла не должна превышать 14 дней.',
                })}
              </div>
              <small className="mailing-option-card__subtitle">
                {broadcastCycleEnabled
                  ? `${broadcastCycleCount} отправок / ${broadcastCycleEveryHours}ч`
                  : 'Выключено'}
              </small>
            </div>

            <label
              className="settings-native-switch"
              aria-label="Включить циклическую рассылку в канал"
            >
              <input
                type="checkbox"
                checked={broadcastCycleEnabled}
                onChange={(event) => setBroadcastCycleEnabled(event.target.checked)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {broadcastCycleEnabled ? (
            <div className="mailing-option-card__body">
              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Интервал, часов</span>
                <input
                  type="number"
                  min={minCycleHours}
                  max={maxCycleHours}
                  value={broadcastCycleEveryHours}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    setBroadcastCycleEveryHours(
                      Number.isNaN(nextValue)
                        ? minCycleHours
                        : Math.max(minCycleHours, Math.min(maxCycleHours, nextValue)),
                    );
                  }}
                />
              </label>

              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Количество</span>
                <input
                  type="number"
                  min={2}
                  max={maxCycleCount}
                  value={broadcastCycleCount}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    setBroadcastCycleCount(
                      Number.isNaN(nextValue) ? 2 : Math.max(2, Math.min(maxCycleCount, nextValue)),
                    );
                  }}
                />
              </label>

              {broadcastCycleError ? (
                <small className="field__hint">{broadcastCycleError}</small>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div id="channel-settings-detail-broadcast-automation" className="settings-detail-anchor" />

      <div className="mailing-action-bar">
        <div id="channel-settings-detail-broadcast-launch" className="settings-detail-anchor" />
        <button
          type="button"
          className="button button--accent mailing-action-bar__send"
          onClick={onSend}
          disabled={isSending}
        >
          {isSending ? 'Открываем бота...' : 'Продолжить в боте'}
        </button>
        <button
          type="button"
          className="button button--ghost mailing-action-bar__clear"
          onClick={onReset}
          disabled={isSending}
        >
          Очистить
        </button>
      </div>
    </div>
  );
}
