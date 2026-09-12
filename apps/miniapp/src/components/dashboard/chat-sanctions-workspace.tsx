import type { ChatSanctionItem, ChatSanctionsQuery } from '@maxim/contracts';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import {
  Prohibition,
  SoundOff,
  Refresh,
  Search,
  Xmark,
  NavArrowRight,
  UserCircle,
  ShieldCheck,
} from 'iconoir-react';
import type { ApiTransport } from '../../lib/api/transport';
import { getChatSanctions } from '../../lib/api/chat-sanctions-client';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  formatSanctionRemaining,
  sanctionTimeProgress,
  SANCTION_STATUS_LABELS,
  createSanctionClock,
  readSanctionClock,
} from '../../lib/sanction-display';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';
import { useToast } from '../ui/toast';
import './chat-sanctions-workspace.css';

type Props = {
  api: ApiTransport;
  chatId: string;
  chatTitle: string;
  initialUserId?: string | null;
  onProfileActivate: (userId: string, displayName: string) => void;
  onChanged: () => void;
  onRelease: (item: ChatSanctionItem) => Promise<string>;
  describeReason: (item: ChatSanctionItem) => string;
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ChatSanctionsWorkspace({
  api,
  chatId,
  chatTitle,
  initialUserId,
  onProfileActivate,
  onChanged,
  onRelease,
  describeReason,
}: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [status, setStatus] = useState<ChatSanctionsQuery['status']>(
    initialUserId ? 'all' : 'active',
  );
  const [action, setAction] = useState<ChatSanctionsQuery['action']>('all');
  const [userId, setUserId] = useState(initialUserId ?? '');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selected, setSelected] = useState<ChatSanctionItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clock, setClock] = useState(performance.now());
  const releaseLock = useRef(false);
  const pendingSearch = search.trim() !== debouncedSearch;
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);
  const feed = useInfiniteQuery({
    queryKey: ['chat-sanctions', chatId, status, action, debouncedSearch, userId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      getChatSanctions(
        api,
        chatId,
        {
          status,
          action,
          search: debouncedSearch || undefined,
          userId: userId || undefined,
          limit: 30,
          cursor: pageParam,
        },
        signal,
      ),
    getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });
  const items = useMemo(
    () => [
      ...new Map(
        (feed.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
      ).values(),
    ],
    [feed.data],
  );
  const lastPage = feed.data?.pages.at(-1);
  const clockSource = useMemo(
    () =>
      createSanctionClock(lastPage?.serverTime, feed.dataUpdatedAt, Date.now(), performance.now()),
    [lastPage?.serverTime, feed.dataUpdatedAt],
  );
  const nowMs = readSanctionClock(clockSource, clock);
  const refresh = useEffectEvent(() => {
    void feed.refetch();
  });
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') setClock(performance.now());
    };
    const visible = () => {
      if (document.visibilityState !== 'hidden') {
        tick();
        refresh();
      }
    };
    const interval = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    if (
      !feed.isFetching &&
      !feed.error &&
      items.length === 0 &&
      feed.hasNextPage &&
      (feed.data?.pages.length ?? 0) < 3
    )
      void feed.fetchNextPage();
  }, [
    feed.isFetching,
    feed.error,
    feed.hasNextPage,
    feed.data?.pages.length,
    items.length,
    feed.fetchNextPage,
  ]);
  const nextExpiry = items
    .filter((item) => item.status === 'active' && !item.permanent && item.expiresAt)
    .map((item) => Date.parse(item.expiresAt!))
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0];
  useEffect(() => {
    if (!nextExpiry) return;
    const timer = window.setTimeout(
      () => refresh(),
      Math.min(
        2_147_483_647,
        Math.max(0, nextExpiry - readSanctionClock(clockSource, performance.now())) + 100,
      ),
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, clockSource]);

  const release = useMutation({
    mutationFn: async (item: ChatSanctionItem) => {
      if (!item.releaseAction)
        throw new Error('Состояние ограничения изменилось. Обновите список.');
      return onRelease(item);
    },
    onSuccess: (result) => {
      setConfirmOpen(false);
      setSelected(null);
      pushToast({ tone: 'success', title: result });
      void queryClient.invalidateQueries({ queryKey: ['chat-sanctions', chatId] });
      onChanged();
    },
    onSettled: () => {
      releaseLock.current = false;
    },
  });
  const busy = feed.isFetching || pendingSearch;
  const selectedProgress = selected ? sanctionTimeProgress(selected, nowMs) : null;
  const releaseAvailable = Boolean(
    selected?.releaseAction &&
    selected.status === 'active' &&
    (selected.permanent || (selected.expiresAt && Date.parse(selected.expiresAt) > nowMs)),
  );
  const closeDetails = () => {
    if (!release.isPending && !confirmOpen) setSelected(null);
  };

  return (
    <section className="sanctions-workspace" aria-label="Ограничения участников">
      <div className="sanctions-workspace__heading">
        <h2>Ограничения</h2>
        <span role="status">
          {feed.isPending
            ? 'Загрузка...'
            : `В списке: ${items.length}${feed.hasNextPage ? '+' : ''}`}
        </span>
      </div>
      <div className="sanctions-workspace__toolbar">
        <label className="sanctions-workspace__search">
          <Search width={19} height={19} aria-hidden />
          <input
            aria-label="Поиск ограничений"
            type="search"
            placeholder="Имя или ID"
            maxLength={100}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button
              type="button"
              title="Очистить поиск"
              aria-label="Очистить поиск"
              onClick={() => setSearch('')}
            >
              <Xmark width={20} height={20} aria-hidden />
            </button>
          ) : null}
        </label>
        <button
          className="sanctions-workspace__icon-button"
          type="button"
          title="Обновить ограничения"
          aria-label="Обновить ограничения"
          disabled={busy}
          onClick={() => void feed.refetch()}
        >
          <Refresh width={21} height={21} aria-hidden />
        </button>
      </div>
      <div className="sanctions-workspace__filters">
        <label>
          <span>Состояние</span>
          <select
            aria-label="Состояние ограничения"
            value={status}
            onChange={(event) => setStatus(event.target.value as ChatSanctionsQuery['status'])}
          >
            <option value="active">Действуют</option>
            <option value="archive">Архив</option>
            <option value="review">Проверка</option>
            <option value="all">Все</option>
          </select>
        </label>
        <label>
          <span>Тип</span>
          <select
            aria-label="Тип ограничения"
            value={action}
            onChange={(event) => setAction(event.target.value as ChatSanctionsQuery['action'])}
          >
            <option value="all">Все типы</option>
            <option value="MUTE">Запрет писать</option>
            <option value="BAN">Блокировка</option>
          </select>
        </label>
      </div>
      {userId ? (
        <div className="sanctions-workspace__user-filter">
          <span>ID {userId}</span>
          <button
            type="button"
            title="Все участники"
            aria-label="Все участники"
            onClick={() => setUserId('')}
          >
            <Xmark width={20} height={20} aria-hidden />
          </button>
        </div>
      ) : null}
      {feed.error ? (
        <div className="sanctions-workspace__notice" role="alert">
          <p>{describeUserFacingError(feed.error, 'Не удалось загрузить ограничения.')}</p>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void (feed.isFetchNextPageError ? feed.fetchNextPage() : feed.refetch())}
            disabled={busy}
          >
            <Refresh width={18} height={18} aria-hidden />
            Повторить
          </button>
        </div>
      ) : null}
      {feed.isPending || pendingSearch ? (
        <div className="sanctions-workspace__empty">
          <Spinner size="lg" label="Загружаем ограничения" />
        </div>
      ) : null}
      {!feed.isPending && !pendingSearch && !feed.error && items.length === 0 ? (
        <div className="sanctions-workspace__empty">
          <ShieldCheck width={32} height={32} aria-hidden />
          <strong>
            {feed.hasNextPage ? 'Поиск по истории продолжается' : 'Ограничений не найдено'}
          </strong>
        </div>
      ) : null}
      {!pendingSearch ? (
        <div className="sanctions-workspace__list" aria-busy={feed.isFetching}>
          {items.map((item) => (
            <button
              type="button"
              key={item.id}
              className="sanctions-workspace__row"
              disabled={feed.isRefetching}
              onClick={() => {
                release.reset();
                setSelected(item);
              }}
            >
              <PersonAvatar
                avatarUrl={item.avatarUrl}
                fallback={item.userDisplayName.slice(0, 1)}
                className="sanctions-workspace__avatar"
              />
              <span className="sanctions-workspace__identity">
                <strong>{item.userDisplayName}</strong>
                <span>{describeReason(item)}</span>
                <small>
                  {item.operator === 'ADMIN' ? 'Администратор' : 'Автоматически'} ·{' '}
                  {new Date(item.createdAt).toLocaleDateString('ru-RU')}
                </small>
              </span>
              <span
                className={`sanctions-workspace__state sanctions-workspace__state--${item.action === 'BAN' ? 'ban' : 'mute'}`}
              >
                <span>
                  {item.action === 'BAN' ? (
                    <Prohibition width={15} height={15} aria-hidden />
                  ) : (
                    <SoundOff width={15} height={15} aria-hidden />
                  )}
                  {item.action === 'BAN' ? 'Блокировка' : 'Запрет писать'}
                </span>
                <strong className="sanctions-workspace__timer">
                  {formatSanctionRemaining(item, nowMs)}
                </strong>
              </span>
              <NavArrowRight
                className="sanctions-workspace__arrow"
                width={18}
                height={18}
                aria-hidden
              />
            </button>
          ))}
        </div>
      ) : null}
      {feed.hasNextPage && !pendingSearch ? (
        <button
          type="button"
          className="button button--ghost sanctions-workspace__more"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetching}
        >
          {feed.isFetchingNextPage
            ? 'Загружаем...'
            : items.length
              ? 'Показать ещё'
              : 'Продолжить поиск'}
        </button>
      ) : null}

      <SettingsDrilldownPanel
        id="sanction-details"
        open={Boolean(selected)}
        title={selected?.userDisplayName ?? 'Ограничение'}
        summary={chatTitle}
        onClose={closeDetails}
        className="sanction-details"
      >
        {selected ? (
          <>
            <div
              className={`sanction-details__status sanction-details__status--${selected.action === 'BAN' ? 'ban' : 'mute'}`}
            >
              <span>{selected.action === 'BAN' ? 'Блокировка' : 'Запрет писать'}</span>
              <strong>{formatSanctionRemaining(selected, nowMs)}</strong>
              {selectedProgress !== null ? (
                <progress
                  max={1}
                  value={selectedProgress}
                  aria-label="Оставшийся срок ограничения"
                />
              ) : null}
            </div>
            <p className="sanction-details__reason">{describeReason(selected)}</p>
            <dl className="sanction-details__facts">
              <div>
                <dt>Состояние</dt>
                <dd>{SANCTION_STATUS_LABELS[selected.status]}</dd>
              </div>
              <div>
                <dt>Назначено</dt>
                <dd>{formatDate(selected.createdAt)}</dd>
              </div>
              {selected.expiresAt ? (
                <div>
                  <dt>Окончание</dt>
                  <dd>{formatDate(selected.expiresAt)}</dd>
                </div>
              ) : null}
              {selected.endedAt ? (
                <div>
                  <dt>Завершено</dt>
                  <dd>{formatDate(selected.endedAt)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Инициатор</dt>
                <dd>
                  {selected.actorDisplayName ??
                    (selected.operator === 'ADMIN' ? 'Администратор' : 'Автомодерация')}
                </dd>
              </div>
              <div>
                <dt>Участник</dt>
                <dd>ID {selected.userId}</dd>
              </div>
            </dl>
            <div className="sanction-details__actions">
              <button
                type="button"
                className="button button--ghost"
                disabled={release.isPending}
                onClick={() => onProfileActivate(selected.userId, selected.userDisplayName)}
              >
                <UserCircle width={20} height={20} aria-hidden />
                Профиль
              </button>
              <button
                type="button"
                className="button button--ghost"
                disabled={release.isPending}
                onClick={() => {
                  setUserId(selected.userId);
                  setSearch('');
                  setStatus('all');
                  setSelected(null);
                }}
              >
                <Search width={20} height={20} aria-hidden />
                История участника
              </button>
              {releaseAvailable ? (
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => {
                    release.reset();
                    setConfirmOpen(true);
                  }}
                >
                  <ShieldCheck width={20} height={20} aria-hidden />
                  {selected.action === 'BAN' ? 'Снять блокировку' : 'Разрешить писать'}
                </button>
              ) : null}
            </div>
          </>
        ) : null}
      </SettingsDrilldownPanel>
      <ActionConfirmSheet
        id="sanction-release"
        open={confirmOpen && Boolean(selected)}
        title={selected?.action === 'BAN' ? 'Снять блокировку?' : 'Разрешить писать?'}
        summary={selected?.userDisplayName}
        previewTitle={chatTitle}
        previewMeta={
          release.error ? (
            <span role="alert">
              {describeUserFacingError(release.error, 'Не удалось снять ограничение.')}
            </span>
          ) : selected ? (
            `Назначено ${formatDate(selected.createdAt)}`
          ) : undefined
        }
        confirmLabel="Снять ограничение"
        confirmBusyLabel="Снимаем..."
        tone="accent"
        isBusy={release.isPending}
        onClose={() => {
          if (!release.isPending) setConfirmOpen(false);
        }}
        onConfirm={() => {
          if (selected && !releaseLock.current && !release.isPending) {
            releaseLock.current = true;
            release.mutate(selected);
          }
        }}
      />
    </section>
  );
}
