import type { ManagedBroadcastDetails, ManagedBroadcastSummary } from '@maxim/contracts';
import type { ReactElement } from 'react';
import { cn } from '../../lib/cn';

type MailingHintKey = 'mailingTargets' | 'mailingButton' | 'mailingSchedule' | 'mailingCycle';

type RenderMailingHintAnchor = (props: {
  hintKey: MailingHintKey;
  label: string;
  children: string;
}) => ReactElement;

function SectionChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <span className={cn('settings-section__chevron', isOpen && 'is-open')} aria-hidden>
      <svg
        className="settings-section__chevron-icon"
        viewBox="0 0 20 20"
        fill="none"
        focusable="false"
      >
        <path
          d="M5.5 7.75L10 12.25L14.5 7.75"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function formatManagedBroadcastDateTime(value: string | null): string {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

export function ChatMailingSectionContent({
  managedBroadcasts,
  managedBroadcastsLoading,
  expandedManagedBroadcastId,
  editingManagedBroadcast,
  isMailingBusy,
  isUpdatingManagedBroadcast,
  isHandoffPending,
  isLoadingManagedBroadcast,
  canApplyToAllChats,
  chatsCount,
  mailingApplyToAllChats,
  mailingButtonEnabled,
  mailingButtonUrl,
  mailingButtonText,
  mailingButtonUrlError,
  mailingButtonTextError,
  mailingScheduleEnabled,
  mailingScheduleDays,
  mailingScheduleTime,
  mailingScheduleError,
  mailingSchedulePreview,
  mailingCycleEnabled,
  mailingCycleEveryHours,
  mailingCycleCount,
  mailingCycleCountMin,
  mailingCycleError,
  mailingCycleSummary,
  minCycleHours,
  maxCycleHours,
  maxCycleCount,
  maxScheduleDays,
  renderHintAnchor,
  onToggleManagedBroadcast,
  onRetryManagedBroadcast,
  onEditManagedBroadcast,
  onCancelManagedBroadcast,
  onSetMailingApplyToAllChats,
  onSetMailingButtonEnabled,
  onSetMailingButtonUrl,
  onSetMailingButtonText,
  onSetMailingScheduleEnabled,
  onSetMailingScheduleDays,
  onSetMailingScheduleTime,
  onSetMailingCycleEnabled,
  onSetMailingCycleEveryHours,
  onSetMailingCycleCount,
  onSend,
  onReset,
}: {
  managedBroadcasts: ManagedBroadcastSummary[];
  managedBroadcastsLoading: boolean;
  expandedManagedBroadcastId: string | null;
  editingManagedBroadcast: ManagedBroadcastDetails | null;
  isMailingBusy: boolean;
  isUpdatingManagedBroadcast: boolean;
  isHandoffPending: boolean;
  isLoadingManagedBroadcast: boolean;
  canApplyToAllChats: boolean;
  chatsCount: number;
  mailingApplyToAllChats: boolean;
  mailingButtonEnabled: boolean;
  mailingButtonUrl: string;
  mailingButtonText: string;
  mailingButtonUrlError: string;
  mailingButtonTextError: string;
  mailingScheduleEnabled: boolean;
  mailingScheduleDays: number;
  mailingScheduleTime: string;
  mailingScheduleError: string;
  mailingSchedulePreview: string;
  mailingCycleEnabled: boolean;
  mailingCycleEveryHours: number;
  mailingCycleCount: number;
  mailingCycleCountMin: number;
  mailingCycleError: string;
  mailingCycleSummary: string;
  minCycleHours: number;
  maxCycleHours: number;
  maxCycleCount: number;
  maxScheduleDays: number;
  renderHintAnchor: RenderMailingHintAnchor;
  onToggleManagedBroadcast: (broadcastId: string) => void;
  onRetryManagedBroadcast: (broadcastId: string) => void;
  onEditManagedBroadcast: (broadcastId: string) => void;
  onCancelManagedBroadcast: (broadcastId: string) => void;
  onSetMailingApplyToAllChats: (value: boolean) => void;
  onSetMailingButtonEnabled: (value: boolean) => void;
  onSetMailingButtonUrl: (value: string) => void;
  onSetMailingButtonText: (value: string) => void;
  onSetMailingScheduleEnabled: (value: boolean) => void;
  onSetMailingScheduleDays: (value: number) => void;
  onSetMailingScheduleTime: (value: string) => void;
  onSetMailingCycleEnabled: (value: boolean) => void;
  onSetMailingCycleEveryHours: (value: number) => void;
  onSetMailingCycleCount: (value: number) => void;
  onSend: () => void;
  onReset: () => void;
}) {
  return (
    <>
      <div className="managed-broadcasts-list">
        <div className="managed-broadcasts-list__head">
          <span className="managed-broadcasts-list__title">Текущие рассылки</span>
          <small className="managed-broadcasts-list__meta">
            {managedBroadcastsLoading
              ? 'Загрузка...'
              : managedBroadcasts.length > 0
                ? `${managedBroadcasts.length} в работе`
                : 'Нет активных рассылок'}
          </small>
        </div>

        {managedBroadcasts.map((broadcast) => {
          const isOpen = expandedManagedBroadcastId === broadcast.id;
          const progressLabel = `${broadcast.sentCount}/${broadcast.cycleCount}`;
          const nextLabel = broadcast.nextSendAt
            ? formatManagedBroadcastDateTime(broadcast.nextSendAt)
            : 'ожидает правки';
          const deliveryLabel =
            broadcast.failedChats > 0
              ? `${broadcast.deliveredChats}/${broadcast.targetChats} доставлено · ошибок ${broadcast.failedChats}`
              : `${broadcast.deliveredChats}/${broadcast.targetChats} доставлено`;

          return (
            <div
              key={broadcast.id}
              className={cn(
                'managed-broadcast-card',
                isOpen && 'is-open',
                (broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL') && 'is-failed',
              )}
            >
              <button
                type="button"
                className="managed-broadcast-card__toggle"
                aria-expanded={isOpen}
                aria-controls={`managed-broadcast-${broadcast.id}`}
                onClick={() => onToggleManagedBroadcast(broadcast.id)}
              >
                <span className="managed-broadcast-card__main">
                  <strong>
                    {broadcast.status === 'PARTIAL'
                      ? `Частично доставлено · повторить ${broadcast.failedChats}`
                      : broadcast.status === 'FAILED'
                        ? `Не доставлено · ошибок ${broadcast.failedChats}`
                        : `Следующая: ${nextLabel}`}
                  </strong>
                  <small>{broadcast.textPreview}</small>
                </span>
                <span className="managed-broadcast-card__aside">
                  <small>{`Цикл ${progressLabel}`}</small>
                  <SectionChevron isOpen={isOpen} />
                </span>
              </button>

              <div
                id={`managed-broadcast-${broadcast.id}`}
                className={cn('managed-broadcast-card__body', isOpen && 'is-open')}
              >
                <div className="managed-broadcast-card__facts">
                  <span>{broadcast.applyToAllChats ? 'Во все чаты' : 'Только этот чат'}</span>
                  <span>{`Чатов: ${broadcast.targetChats}`}</span>
                  <span>{broadcast.hasImage ? 'С фото' : 'Без фото'}</span>
                  <span>{broadcast.buttonEnabled ? 'С кнопкой' : 'Без кнопки'}</span>
                  <span>
                    {broadcast.cycleEnabled
                      ? `Каждые ${broadcast.cycleEveryHours}ч`
                      : 'Одна отправка'}
                  </span>
                  <span>{deliveryLabel}</span>
                  {broadcast.pendingChats > 0 ? (
                    <span>{`Ожидают: ${broadcast.pendingChats}`}</span>
                  ) : null}
                </div>
                {broadcast.lastError ? (
                  <small className="field__hint">{broadcast.lastError}</small>
                ) : null}
                <div className="managed-broadcast-card__actions">
                  {broadcast.canRetry ? (
                    <button
                      type="button"
                      className="button button--accent"
                      onClick={() => onRetryManagedBroadcast(broadcast.id)}
                      disabled={isMailingBusy}
                    >
                      Повторить ошибки
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => onEditManagedBroadcast(broadcast.id)}
                    disabled={isMailingBusy || isLoadingManagedBroadcast || broadcast.canRetry}
                  >
                    {isLoadingManagedBroadcast && expandedManagedBroadcastId === broadcast.id
                      ? 'Открываем...'
                      : 'Редактировать'}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => onCancelManagedBroadcast(broadcast.id)}
                    disabled={isMailingBusy}
                  >
                    Остановить
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {editingManagedBroadcast ? (
        <div className="managed-broadcast-editor-note">
          <strong>Редактирование рассылки</strong>
          <small>
            {editingManagedBroadcast.sentCount > 0
              ? `Уже отправлено: ${editingManagedBroadcast.sentCount} из ${editingManagedBroadcast.cycleCount}.`
              : 'Контент уже сохранён. Здесь можно менять кнопку, охват и следующее время отправки.'}
          </small>
        </div>
      ) : null}

      <div className={cn('mailing-target-card', !canApplyToAllChats && 'is-single-chat')}>
        <div className="mailing-target-card__row">
          <div className="mailing-target-card__title-wrap">
            <div className="mailing-card-title-row">
              <span className="mailing-target-card__title">Применить во всех чатах</span>
              {renderHintAnchor({
                hintKey: 'mailingTargets',
                label: 'Пояснение для массовой рассылки',
                children: canApplyToAllChats
                  ? `Отправим в ${chatsCount} чатах, где у вас и у бота есть админ-права.`
                  : 'Пока доступен только текущий чат.',
              })}
            </div>
            <small className="mailing-target-card__meta">
              {mailingApplyToAllChats && canApplyToAllChats
                ? `Выбрано чатов: ${chatsCount}`
                : 'Отправка в текущий чат'}
            </small>
          </div>

          <label className="settings-native-switch" aria-label="Применить рассылку во всех чатах">
            <input
              type="checkbox"
              checked={mailingApplyToAllChats && canApplyToAllChats}
              onChange={(event) => onSetMailingApplyToAllChats(event.target.checked)}
              disabled={!canApplyToAllChats || isMailingBusy}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>
      </div>

      <div className="managed-broadcast-editor-note">
        <strong>
          {editingManagedBroadcast ? 'Контент меняется в боте' : 'Контент собирается в боте'}
        </strong>
        <small>
          {editingManagedBroadcast
            ? 'Чтобы заменить текст или фото, откройте новую рассылку через личный чат бота.'
            : 'В miniapp остаются только параметры. После кнопки ниже откроется личка бота, где можно отправить текст или фото обычным сообщением.'}
        </small>
      </div>

      <div className="mailing-options-grid">
        <div
          className={cn(
            'mailing-option-card',
            mailingButtonEnabled && 'is-enabled',
            (mailingButtonUrlError || mailingButtonTextError) && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="mailing-card-title-row">
                <span className="mailing-option-card__title">Кнопка действия</span>
                {renderHintAnchor({
                  hintKey: 'mailingButton',
                  label: 'Пояснение для кнопки рассылки',
                  children:
                    'Кнопка ведёт на канал, пост или внешнюю форму. Ссылка должна быть http/https, подпись кнопки до 32 символов.',
                })}
              </div>
            </div>

            <label className="settings-native-switch" aria-label="Добавить кнопку в рассылку">
              <input
                type="checkbox"
                checked={mailingButtonEnabled}
                onChange={(event) => onSetMailingButtonEnabled(event.target.checked)}
                disabled={isMailingBusy}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {mailingButtonEnabled ? (
            <div className="mailing-option-card__body">
              <label
                className={cn('field settings-url-field', mailingButtonUrlError && 'field--error')}
              >
                <span className="field__label">Ссылка кнопки</span>
                <input
                  type="url"
                  inputMode="url"
                  value={mailingButtonUrl}
                  onChange={(event) => onSetMailingButtonUrl(event.target.value)}
                  placeholder="https://max.ru/channel/..."
                  disabled={isMailingBusy}
                />
                {mailingButtonUrlError ? (
                  <small className="field__hint">{mailingButtonUrlError}</small>
                ) : null}
              </label>

              <label
                className={cn(
                  'field settings-text-field',
                  mailingButtonTextError && 'field--error',
                )}
              >
                <span className="field__label">Название кнопки</span>
                <input
                  type="text"
                  maxLength={32}
                  value={mailingButtonText}
                  onChange={(event) => onSetMailingButtonText(event.target.value)}
                  placeholder="Открыть"
                  disabled={isMailingBusy}
                />
                {mailingButtonTextError ? (
                  <small className="field__hint">{mailingButtonTextError}</small>
                ) : null}
              </label>
            </div>
          ) : null}
        </div>
      </div>

      <div id="settings-detail-mailing-automation" className="settings-detail-anchor" />

      <div className="mailing-options-grid mailing-options-grid--timing">
        <div
          className={cn(
            'mailing-option-card',
            mailingScheduleEnabled && 'is-enabled',
            mailingScheduleError && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="mailing-card-title-row">
                <span className="mailing-option-card__title">Таймер отправки</span>
                {renderHintAnchor({
                  hintKey: 'mailingSchedule',
                  label: 'Пояснение для таймера рассылки',
                  children:
                    'Отложенная отправка доступна до 14 дней вперёд. Если таймер выключен, сообщение уйдёт сразу.',
                })}
              </div>
            </div>

            <label className="settings-native-switch" aria-label="Включить таймер рассылки">
              <input
                type="checkbox"
                checked={mailingScheduleEnabled}
                onChange={(event) => onSetMailingScheduleEnabled(event.target.checked)}
                disabled={isMailingBusy}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {mailingScheduleEnabled ? (
            <div className="mailing-option-card__body mailing-inline-fields">
              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Через сколько дней</span>
                <input
                  type="number"
                  min={0}
                  max={maxScheduleDays}
                  value={mailingScheduleDays}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    onSetMailingScheduleDays(
                      Number.isNaN(nextValue)
                        ? 0
                        : Math.max(0, Math.min(maxScheduleDays, nextValue)),
                    );
                  }}
                  disabled={isMailingBusy}
                />
              </label>

              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Время</span>
                <input
                  type="time"
                  value={mailingScheduleTime}
                  onChange={(event) => onSetMailingScheduleTime(event.target.value)}
                  disabled={isMailingBusy}
                />
              </label>
            </div>
          ) : null}

          {mailingScheduleError ? (
            <small className="field__hint">{mailingScheduleError}</small>
          ) : mailingScheduleEnabled && mailingSchedulePreview ? (
            <small className="mailing-option-card__hint is-info">{`Отправка: ${mailingSchedulePreview}`}</small>
          ) : null}
        </div>

        <div
          className={cn(
            'mailing-option-card',
            mailingCycleEnabled && 'is-enabled',
            mailingCycleError && 'field--error',
          )}
        >
          <div className="mailing-option-card__head">
            <div className="mailing-option-card__title-wrap">
              <div className="mailing-card-title-row">
                <span className="mailing-option-card__title">Циклическая рассылка</span>
                {renderHintAnchor({
                  hintKey: 'mailingCycle',
                  label: 'Пояснение для циклической рассылки',
                  children:
                    'Интервал повторов задаётся в часах от 1 до 24. Максимум 100 отправок, но весь цикл всё равно должен уместиться в 14 дней.',
                })}
              </div>
            </div>

            <label className="settings-native-switch" aria-label="Включить циклическую рассылку">
              <input
                type="checkbox"
                checked={mailingCycleEnabled}
                onChange={(event) => onSetMailingCycleEnabled(event.target.checked)}
                disabled={isMailingBusy || Boolean(editingManagedBroadcast?.sentCount)}
              />
              <span className="toggle-switch" aria-hidden>
                <span className="toggle-switch__thumb" />
              </span>
            </label>
          </div>

          {mailingCycleEnabled ? (
            <div className="mailing-option-card__body mailing-inline-fields">
              <div className="mailing-inline-field mailing-hours-stepper">
                <span className="mailing-hours-stepper__label">Интервал (часы)</span>
                <div className="mailing-hours-stepper__control">
                  <button
                    type="button"
                    className="mailing-hours-stepper__button"
                    onClick={() =>
                      onSetMailingCycleEveryHours(
                        Math.max(minCycleHours, mailingCycleEveryHours - 1),
                      )
                    }
                    disabled={isMailingBusy || mailingCycleEveryHours <= minCycleHours}
                    aria-label="Уменьшить интервал цикла"
                  >
                    -
                  </button>

                  <div className="mailing-hours-stepper__value" aria-live="polite">
                    {mailingCycleEveryHours}ч
                  </div>

                  <button
                    type="button"
                    className="mailing-hours-stepper__button"
                    onClick={() =>
                      onSetMailingCycleEveryHours(
                        Math.min(maxCycleHours, mailingCycleEveryHours + 1),
                      )
                    }
                    disabled={isMailingBusy || mailingCycleEveryHours >= maxCycleHours}
                    aria-label="Увеличить интервал цикла"
                  >
                    +
                  </button>
                </div>
              </div>

              <label className="field settings-text-field mailing-inline-field">
                <span className="field__label">Количество отправок</span>
                <input
                  type="number"
                  min={mailingCycleCountMin}
                  max={maxCycleCount}
                  value={mailingCycleCount}
                  onChange={(event) => {
                    const nextValue = Number.parseInt(event.target.value, 10);
                    onSetMailingCycleCount(
                      Number.isNaN(nextValue)
                        ? mailingCycleCountMin
                        : Math.max(mailingCycleCountMin, Math.min(maxCycleCount, nextValue)),
                    );
                  }}
                  disabled={isMailingBusy}
                />
              </label>
            </div>
          ) : null}

          {mailingCycleError ? (
            <small className="field__hint">{mailingCycleError}</small>
          ) : editingManagedBroadcast?.sentCount ? (
            <small className="mailing-option-card__hint is-info">
              После первого запуска можно менять шаг, время и общий лимит отправок.
            </small>
          ) : mailingCycleEnabled && mailingCycleSummary ? (
            <small className="mailing-option-card__hint is-info">{`Цикл: ${mailingCycleSummary}`}</small>
          ) : null}
        </div>
      </div>

      <div id="settings-detail-mailing-launch" className="settings-detail-anchor" />

      <div className="mailing-action-bar">
        <button
          type="button"
          className="button button--accent mailing-action-bar__send"
          onClick={onSend}
          disabled={isMailingBusy}
        >
          {isUpdatingManagedBroadcast
            ? 'Сохраняем...'
            : isHandoffPending
              ? 'Открываем бота...'
              : editingManagedBroadcast
                ? 'Сохранить рассылку'
                : 'Продолжить в боте'}
        </button>
        <button
          type="button"
          className="button button--ghost mailing-action-bar__clear"
          onClick={onReset}
          disabled={isMailingBusy}
        >
          {editingManagedBroadcast ? 'Отменить редактирование' : 'Очистить'}
        </button>
      </div>
    </>
  );
}
