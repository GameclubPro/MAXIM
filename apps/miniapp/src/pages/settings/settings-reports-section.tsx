import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import type {
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';
import type { FieldErrors } from './settings-page-helpers';
import './settings-reports.css';

export type SettingsReportsSectionProps = SettingsSectionShellProps &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue'> & {
    api: ApiTransport;
    chatId: string;
    fieldErrors: FieldErrors;
    reportsAvailable: boolean;
    persistedReportsEnabled: boolean;
    reportsAvailabilityLoading?: boolean;
  };

function ReportMark({ kind }: { kind: 'signal' | 'message' | 'history' | 'commands' }) {
  const paths = {
    signal: 'M12 3 20 6v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-3 9 2 2 4-4',
    message: 'M5 4h14v13H9l-4 4V4Zm4 5h6m-6 4h4',
    history: 'M4 8a9 9 0 1 1-1 7M4 3v5h5m3 0v5l3 2',
    commands: 'm8 6-5 6 5 6m8-12 5 6-5 6m-3-14-2 16',
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={paths[kind]}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReportSwitch({ children }: { children: ReactNode }) {
  return (
    <span className="reports-switch">
      {children}
      <span className="reports-switch__track" aria-hidden="true" />
    </span>
  );
}

export function SettingsReportsSection(props: SettingsReportsSectionProps) {
  const { draft, setFieldValue, expanded } = props;
  const [tab, setTab] = useState<'settings' | 'journal'>('settings');
  const [aliasesText, setAliasesText] = useState(draft.reportsAliases.join(', '));
  useEffect(() => {
    const buffered = aliasesText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (JSON.stringify(buffered) !== JSON.stringify(draft.reportsAliases))
      setAliasesText(draft.reportsAliases.join(', '));
  }, [draft.reportsAliases]);
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      expanded &&
      tab === 'settings' &&
      Object.keys(props.fieldErrors).some((key) => key.startsWith('reports'))
    )
      paneRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]:not(.reports-threshold-input)')
        ?.focus();
  }, [props.fieldErrors, expanded, tab]);
  const errorProps = (field: keyof FieldErrors) => ({
    'aria-invalid': Boolean(props.fieldErrors[field]) || undefined,
    'aria-describedby': props.fieldErrors[field] ? `${field}-error` : undefined,
  });
  const fieldError = (field: keyof FieldErrors) =>
    props.fieldErrors[field] ? (
      <small id={`${field}-error`} className="reports-field__error" role="alert">
        {props.fieldErrors[field]}
      </small>
    ) : null;
  return (
    <section
      className="settings-section settings-home-entry settings-home-entry--list"
      style={{ order: 13 }}
      aria-label="Система жалоб"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Система жалоб"
          summary={draft.reportsEnabled ? `Порог: ${draft.reportsThreshold}` : ''}
          status={
            draft.reportsEnabled ? (props.reportsAvailable ? 'Вкл' : 'Приостановлен') : 'Выкл'
          }
          icon="warning"
          tone="rose"
          open={expanded}
          controls="settings-reports-content"
          onClick={() => props.toggleSection('reports')}
        />
      </div>
      <SettingsDrilldownPanel
        id="settings-reports-content"
        open={expanded}
        title="Система жалоб"
        tone="rose"
        className="settings-drilldown__panel--reports"
        onClose={() => props.toggleSection('reports')}
        headerAction={props.renderApplyTargetHeaderAction('reports')}
        confirmCloseWhen={props.isSectionDirty('reports')}
        onDiscardChanges={() => props.discardSectionChanges('reports')}
        footer={tab === 'settings' ? props.renderSectionSaveFooter('reports') : null}
      >
        {expanded && (
          <div className="reports-settings">
            <div
              className="reports-tabs"
              role="tablist"
              aria-label="Система жалоб"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'settings'
                    : event.key === 'End'
                      ? 'journal'
                      : tab === 'settings'
                        ? 'journal'
                        : 'settings';
                setTab(next);
                const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
                buttons[next === 'settings' ? 0 : 1]?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                id="reports-settings-tab"
                aria-controls="reports-settings-pane"
                aria-selected={tab === 'settings'}
                tabIndex={tab === 'settings' ? 0 : -1}
                onClick={() => setTab('settings')}
              >
                Настройки
              </button>
              <button
                type="button"
                role="tab"
                id="reports-journal-tab"
                aria-controls="reports-journal-pane"
                aria-selected={tab === 'journal'}
                tabIndex={tab === 'journal' ? 0 : -1}
                onClick={() => setTab('journal')}
              >
                Журнал
              </button>
            </div>
            {tab === 'journal' ? (
              <ReportJournal api={props.api} chatId={props.chatId} />
            ) : (
              <div
                ref={paneRef}
                role="tabpanel"
                id="reports-settings-pane"
                aria-labelledby="reports-settings-tab"
              >
                {!props.reportsAvailable && (
                  <p className="reports-availability" role="status">
                    {props.reportsAvailabilityLoading
                      ? 'Проверяем приём жалоб…'
                      : 'Приём жалоб приостановлен оператором.'}
                  </p>
                )}
                <div className="reports-intro">
                  <div className="reports-intro__top">
                    <span className="reports-intro__eyebrow">Участники помогают модерации</span>
                    <span className="reports-intro__mark">
                      <ReportMark kind="signal" />
                    </span>
                  </div>
                  <strong>
                    {draft.reportsThreshold} {draft.reportsThreshold < 5 ? 'голоса' : 'голосов'} —
                    одно решение
                  </strong>
                  <p>
                    Отправьте <b>/report</b> или <b>жалоба</b> ответом на сообщение. Бот применит
                    выбранные меры, когда наберётся порог голосов.
                  </p>
                  <label className="reports-toggle reports-toggle--activation">
                    <span>
                      Жалобы участников
                      <small>
                        {draft.reportsEnabled
                          ? 'Включены в этом чате'
                          : 'Включите после настройки мер'}
                      </small>
                    </span>
                    <ReportSwitch>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Жалобы участников"
                        checked={draft.reportsEnabled}
                        disabled={!props.reportsAvailable && !props.persistedReportsEnabled}
                        {...errorProps('reportsEnabled')}
                        onChange={(event) => setFieldValue('reportsEnabled', event.target.checked)}
                      />
                    </ReportSwitch>
                  </label>
                  {fieldError('reportsEnabled')}
                </div>
                <section className="reports-group reports-group--threshold">
                  <div className="reports-group__heading">
                    <span className="reports-group__number">01</span>
                    <h3>Сколько голосов нужно</h3>
                  </div>
                  <div className="reports-field">
                    <span id="reports-threshold-label" className="field__label">
                      Порог жалоб
                    </span>
                    <div
                      className="reports-threshold-buttons"
                      role="radiogroup"
                      aria-labelledby="reports-threshold-label"
                      aria-describedby={
                        props.fieldErrors.reportsThreshold ? 'reportsThreshold-error' : undefined
                      }
                      onKeyDown={(event) => {
                        if (
                          ![
                            'ArrowLeft',
                            'ArrowRight',
                            'ArrowUp',
                            'ArrowDown',
                            'Home',
                            'End',
                          ].includes(event.key)
                        )
                          return;
                        event.preventDefault();
                        const next =
                          event.key === 'Home'
                            ? 2
                            : event.key === 'End'
                              ? 6
                              : Math.min(
                                  6,
                                  Math.max(
                                    2,
                                    draft.reportsThreshold +
                                      (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1),
                                  ),
                                );
                        setFieldValue('reportsThreshold', next);
                        event.currentTarget
                          .querySelectorAll<HTMLButtonElement>('button')
                          .item(next - 2)
                          ?.focus();
                      }}
                    >
                      {[2, 3, 4, 5, 6].map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-label={`${value} ${value < 5 ? 'голоса' : 'голосов'}`}
                          aria-checked={draft.reportsThreshold === value}
                          tabIndex={draft.reportsThreshold === value ? 0 : -1}
                          onClick={() => setFieldValue('reportsThreshold', value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <input
                      className="reports-threshold-input"
                      aria-label="Порог жалоб"
                      type="number"
                      min={2}
                      max={6}
                      step={1}
                      value={draft.reportsThreshold}
                      {...errorProps('reportsThreshold')}
                      onChange={(event) =>
                        setFieldValue('reportsThreshold', Number(event.target.value))
                      }
                    />
                    <small>Нужны голоса разных участников по одному сообщению.</small>
                    {fieldError('reportsThreshold')}
                  </div>
                </section>
                <section className="reports-group reports-group--measures">
                  <div className="reports-group__heading">
                    <span className="reports-group__number">02</span>
                    <h3>Что произойдёт</h3>
                  </div>
                  <p className="reports-group__caption reports-mobile-copy">
                    Когда наберётся {draft.reportsThreshold}{' '}
                    {draft.reportsThreshold < 5 ? 'голоса' : 'голосов'}
                  </p>
                  <div className="reports-field">
                    <span id="reports-delete-label" className="field__label reports-desktop-copy">
                      Удаление
                    </span>
                    <div className="reports-delete-options" role="radiogroup" aria-label="Удаление">
                      {[
                        {
                          value: 'MESSAGE' as const,
                          title: 'Одно сообщение',
                          description: 'То, на которое пожаловались',
                          icon: 'message' as const,
                        },
                        {
                          value: 'HISTORY_24H' as const,
                          title: 'История за 24 часа',
                          description: 'Сообщения автора за последние сутки',
                          icon: 'history' as const,
                        },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-label={option.title}
                          aria-checked={draft.reportsDeleteMode === option.value}
                          tabIndex={draft.reportsDeleteMode === option.value ? 0 : -1}
                          {...errorProps('reportsDeleteMode')}
                          onKeyDown={(event) => {
                            if (
                              ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(
                                event.key,
                              )
                            ) {
                              event.preventDefault();
                              const next = option.value === 'MESSAGE' ? 'HISTORY_24H' : 'MESSAGE';
                              setFieldValue('reportsDeleteMode', next);
                              const buttons =
                                event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                                  'button',
                                );
                              buttons?.[next === 'MESSAGE' ? 0 : 1]?.focus();
                            }
                          }}
                          onClick={() => setFieldValue('reportsDeleteMode', option.value)}
                        >
                          <span className="reports-option__icon">
                            <ReportMark kind={option.icon} />
                          </span>
                          <span className="reports-option__copy">
                            <strong>{option.title}</strong>
                            <small>{option.description}</small>
                          </span>
                          <span className="reports-option__check" aria-hidden="true">
                            <svg viewBox="0 0 16 16" fill="none">
                              <path
                                d="m4 8 3 3 5-6"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </span>
                        </button>
                      ))}
                    </div>
                    <select
                      className="reports-delete-select"
                      aria-labelledby="reports-delete-label"
                      value={draft.reportsDeleteMode}
                      {...errorProps('reportsDeleteMode')}
                      onChange={(event) =>
                        setFieldValue(
                          'reportsDeleteMode',
                          event.target.value as 'MESSAGE' | 'HISTORY_24H',
                        )
                      }
                    >
                      <option value="MESSAGE">Одно сообщение</option>
                      <option value="HISTORY_24H">История за 24 ч</option>
                    </select>
                    {fieldError('reportsDeleteMode')}
                    <small className="reports-history-note">
                      История охватывает только сообщения, которые бот видел за последние сутки.
                    </small>
                  </div>
                  <label className="reports-toggle reports-toggle--mute">
                    <span>
                      Ограничить участника<small>Новые сообщения будут удаляться ботом.</small>
                    </span>
                    <ReportSwitch>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-label="Ограничить участника"
                        checked={draft.reportsMuteEnabled}
                        {...errorProps('reportsMuteEnabled')}
                        onChange={(event) =>
                          setFieldValue('reportsMuteEnabled', event.target.checked)
                        }
                      />
                    </ReportSwitch>
                  </label>
                  {fieldError('reportsMuteEnabled')}
                  {draft.reportsMuteEnabled && (
                    <div className="reports-field reports-duration">
                      <label htmlFor="reports-mute-duration" className="field__label">
                        Длительность ограничения, ч
                      </label>
                      <div className="reports-duration-control">
                        <button
                          type="button"
                          aria-label="Уменьшить длительность ограничения"
                          disabled={draft.reportsMuteDurationHours <= 1}
                          onClick={() =>
                            setFieldValue(
                              'reportsMuteDurationHours',
                              Math.max(1, draft.reportsMuteDurationHours - 1),
                            )
                          }
                        >
                          −
                        </button>
                        <input
                          id="reports-mute-duration"
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={24}
                          step={1}
                          value={draft.reportsMuteDurationHours}
                          {...errorProps('reportsMuteDurationHours')}
                          onChange={(event) =>
                            setFieldValue('reportsMuteDurationHours', Number(event.target.value))
                          }
                        />
                        <button
                          type="button"
                          aria-label="Увеличить длительность ограничения"
                          disabled={draft.reportsMuteDurationHours >= 24}
                          onClick={() =>
                            setFieldValue(
                              'reportsMuteDurationHours',
                              Math.min(24, draft.reportsMuteDurationHours + 1),
                            )
                          }
                        >
                          +
                        </button>
                      </div>
                      <div
                        className="reports-duration-presets"
                        role="group"
                        aria-label="Быстрая настройка длительности"
                      >
                        {[1, 6, 12, 24].map((hours) => (
                          <button
                            type="button"
                            key={hours}
                            aria-pressed={draft.reportsMuteDurationHours === hours}
                            onClick={() => setFieldValue('reportsMuteDurationHours', hours)}
                          >
                            {hours} ч
                          </button>
                        ))}
                      </div>
                      {fieldError('reportsMuteDurationHours')}
                    </div>
                  )}
                </section>
                <section className="reports-group reports-group--commands">
                  <div className="reports-group__heading">
                    <span className="reports-group__number">03</span>
                    <h3>Как отправить жалобу</h3>
                    <ReportMark kind="commands" />
                  </div>
                  <div className="reports-field">
                    <span className="field__label reports-desktop-copy">Основные команды</span>
                    <div className="reports-command-chips">
                      <span>/report</span>
                      <span>жалоба</span>
                    </div>
                    <small className="reports-mobile-copy">
                      Ответом на сообщение, без вложений
                    </small>
                  </div>
                  <label className="reports-field">
                    <span className="field__label">Дополнительные команды, до 5</span>
                    <input
                      type="text"
                      value={aliasesText}
                      maxLength={170}
                      placeholder="спам, /alert"
                      autoCapitalize="none"
                      autoCorrect="off"
                      {...errorProps('reportsAliases')}
                      onChange={(event) => {
                        setAliasesText(event.target.value);
                        setFieldValue(
                          'reportsAliases',
                          event.target.value
                            .split(',')
                            .map((part) => part.trim())
                            .filter(Boolean),
                        );
                      }}
                    />
                    <small>Перечислите команды через запятую.</small>
                  </label>
                  {fieldError('reportsAliases')}
                </section>
                <details className="reports-rules">
                  <summary>Правила приёма жалоб</summary>
                  <ul>
                    <li>Команда отправляется без вложений, ответом на сообщение младше суток.</li>
                    <li>
                      Участник должен состоять в чате не менее 24 часов. Один участник — один голос
                      на сообщение.
                    </li>
                    <li>
                      Лимит — 10 разных сообщений за час. На администраторов и защищённых участников
                      жалобы не действуют.
                    </li>
                    <li>
                      Порог — от 2 до 6 голосов. Изменение настроек отменяет прежние незавершённые
                      решения.
                    </li>
                    <li>
                      Удалённые сообщения не восстанавливаются. Ограничение можно снять вручную в
                      карточке участника.
                    </li>
                  </ul>
                </details>
              </div>
            )}
          </div>
        )}
      </SettingsDrilldownPanel>
    </section>
  );
}

const LazyReportJournal = lazy(() =>
  import('./settings-reports-journal').then((module) => ({ default: module.ReportJournal })),
);

export function ReportJournal(props: { api: ApiTransport; chatId: string }) {
  return (
    <Suspense
      fallback={
        <div
          className="reports-journal"
          role="tabpanel"
          id="reports-journal-pane"
          aria-labelledby="reports-journal-tab"
        >
          <p role="status">Загружаем журнал…</p>
          <div className="reports-journal__loading" aria-hidden="true">
            <span />
            <span />
          </div>
        </div>
      }
    >
      <LazyReportJournal {...props} />
    </Suspense>
  );
}
