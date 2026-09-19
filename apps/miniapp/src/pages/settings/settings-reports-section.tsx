import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshDouble, NavArrowDown } from 'iconoir-react';
import type { ReportSummary } from '@maxim/contracts/settings';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { SettingsSectionToggle } from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import { dismissReport, getReport, getReports } from '../../lib/api/reports-client';
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
  };

const statuses: Record<ReportSummary['status'], string> = {
  COLLECTING: 'Сбор голосов',
  PENDING: 'В очереди',
  RUNNING: 'Исполняется',
  COMPLETED: 'Выполнено',
  PARTIAL: 'Частично',
  FAILED: 'Ошибка',
  DISMISSED: 'Отклонено',
  EXPIRED: 'Срок истёк',
  CANCELLED: 'Отменено',
};

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
  return (
    <section
      className="settings-section settings-home-entry settings-home-entry--list"
      style={{ order: 13 }}
      aria-label="Жалобы"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title="Жалобы"
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
        title="Жалобы"
        tone="rose"
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
              aria-label="Раздел жалоб"
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
                role="tabpanel"
                id="reports-settings-pane"
                aria-labelledby="reports-settings-tab"
              >
                {!props.reportsAvailable && (
                  <p className="reports-availability" role="status">
                    Приём жалоб приостановлен оператором.
                  </p>
                )}
                {Object.entries(props.fieldErrors)
                  .filter(([key]) => key.startsWith('reports'))
                  .map(([key, error]) => (
                    <p key={key} role="alert">
                      {error}
                    </p>
                  ))}
                <label className="reports-toggle">
                  <span>Жалобы участников</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.reportsEnabled}
                    disabled={!props.reportsAvailable && !draft.reportsEnabled}
                    onChange={(e) => setFieldValue('reportsEnabled', e.target.checked)}
                  />
                </label>
                <label className="reports-field">
                  <span className="field__label">Порог жалоб</span>
                  <input
                    type="number"
                    min={2}
                    max={6}
                    step={1}
                    value={draft.reportsThreshold}
                    onChange={(e) => setFieldValue('reportsThreshold', Number(e.target.value))}
                  />
                </label>
                <div className="reports-field">
                  <span className="field__label">Основные команды</span>
                  <span>/report · жалоба</span>
                </div>
                <label className="reports-field">
                  <span className="field__label">Дополнительные команды, до 5</span>
                  <input
                    type="text"
                    value={aliasesText}
                    maxLength={170}
                    onChange={(e) => {
                      setAliasesText(e.target.value);
                      setFieldValue(
                        'reportsAliases',
                        e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      );
                    }}
                  />
                </label>
                <label className="reports-field">
                  <span className="field__label">Удаление</span>
                  <select
                    value={draft.reportsDeleteMode}
                    onChange={(e) =>
                      setFieldValue(
                        'reportsDeleteMode',
                        e.target.value as 'MESSAGE' | 'HISTORY_24H',
                      )
                    }
                  >
                    <option value="MESSAGE">Одно сообщение</option>
                    <option value="HISTORY_24H">История за 24 ч</option>
                  </select>
                </label>
                <label className="reports-toggle">
                  <span>Мут</span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft.reportsMuteEnabled}
                    onChange={(e) => setFieldValue('reportsMuteEnabled', e.target.checked)}
                  />
                </label>
                {draft.reportsMuteEnabled && (
                  <label className="reports-field">
                    <span className="field__label">Длительность мута, ч</span>
                    <input
                      type="number"
                      min={1}
                      max={24}
                      step={1}
                      value={draft.reportsMuteDurationHours}
                      onChange={(e) =>
                        setFieldValue('reportsMuteDurationHours', Number(e.target.value))
                      }
                    />
                  </label>
                )}
              </div>
            )}
          </div>
        )}
      </SettingsDrilldownPanel>
    </section>
  );
}

export function ReportJournal({ api, chatId }: { api: ApiTransport; chatId: string }) {
  const client = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [chatId]);
  const key = ['chat-reports', chatId];
  const list = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => getReports(api, chatId, pageParam, signal),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const detail = useQuery({
    queryKey: [...key, selected],
    enabled: Boolean(selected),
    queryFn: ({ signal }) => getReport(api, chatId, selected!, signal),
    refetchInterval: 10_000,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => dismissReport(api, chatId, id),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  const items = [
    ...new Map(
      (list.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
    ).values(),
  ];
  return (
    <div
      className="reports-journal"
      role="tabpanel"
      id="reports-journal-pane"
      aria-labelledby="reports-journal-tab"
    >
      <div className="reports-journal__head">
        <h3>Жалобы участников</h3>
        <button
          type="button"
          className="icon-button"
          aria-label="Обновить жалобы"
          title="Обновить жалобы"
          disabled={list.isFetching}
          onClick={() => void list.refetch()}
        >
          <RefreshDouble aria-hidden />
        </button>
      </div>
      {list.isPending && <p role="status">Загрузка…</p>}
      {list.isError && <p role="alert">Не удалось загрузить жалобы.</p>}
      {!list.isPending && !list.isError && items.length === 0 && <p>Жалоб пока нет.</p>}
      {items.map((listed) => {
        const item = selected === listed.id && detail.data?.id === listed.id ? detail.data : listed;
        return (
          <article className="reports-journal__item" key={item.id}>
            <button
              type="button"
              className="reports-journal__summary"
              aria-expanded={selected === item.id}
              onClick={() => {
                dismiss.reset();
                setSelected(selected === item.id ? null : item.id);
              }}
            >
              <span>
                <strong>{statuses[item.status]}</strong>
                <small>{new Date(item.createdAt).toLocaleString('ru-RU')}</small>
              </span>
              <span>
                {item.votes}/{item.threshold}
                <NavArrowDown aria-hidden />
              </span>
            </button>
            {selected === item.id && (
              <div className="reports-journal__detail">
                <dl>
                  <dt>Автор</dt>
                  <dd>{detail.data?.authorName ?? item.authorId}</dd>
                  <dt>Сообщение</dt>
                  <dd>{item.messageId}</dd>
                  <dt>Удалено</dt>
                  <dd>
                    {item.deleted} из {item.candidates}
                  </dd>
                  <dt>В очереди</dt>
                  <dd>{item.pending}</dd>
                  <dt>Уже отсутствуют</dt>
                  <dd>{item.absent}</dd>
                  <dt>Ошибок</dt>
                  <dd>{item.failed}</dd>
                  <dt>Мут</dt>
                  <dd>{item.muteApplied ? `${item.muteHours} ч` : 'Не применён'}</dd>
                </dl>
                {item.lastError && <p role="status">{item.lastError}</p>}
                {detail.isPending && <p role="status">Загрузка участников…</p>}
                {detail.isError && <p role="alert">Не удалось загрузить участников.</p>}
                {detail.data && (
                  <>
                    <h4>Участники</h4>
                    <ul>
                      {detail.data.reporters.map((r) => (
                        <li key={r.userId}>{r.displayName ?? r.userId}</li>
                      ))}
                    </ul>
                  </>
                )}
                {['COLLECTING', 'PENDING'].includes(item.status) && (
                  <button
                    type="button"
                    className="button button--secondary"
                    disabled={dismiss.isPending}
                    onClick={() => dismiss.mutate(item.id)}
                  >
                    Отклонить жалобы
                  </button>
                )}
                {dismiss.isError && <p role="alert">Не удалось отклонить жалобы.</p>}
              </div>
            )}
          </article>
        );
      })}
      {list.hasNextPage && (
        <button
          type="button"
          className="button button--secondary"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          Ещё
        </button>
      )}
    </div>
  );
}
