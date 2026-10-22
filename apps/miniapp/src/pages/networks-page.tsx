import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkCard,
  ManagedEntityType,
} from '@maxim/contracts';
import type { ApiTransport } from '../lib/api/transport';
import { AppIcon } from '../components/ui/app-icon';
import type { AppIconName } from '../components/ui/app-icon-names';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Spinner } from '../components/ui/spinner';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import { useHomeEntityNetworkCatalogue } from '../lib/home-entity-networks-context';
import type { NetworkSettingsOperationReceipt } from '../lib/network-settings-operation-storage';
import { useNativeBackHandler } from '../lib/native-back';
import { useNetworkStatistics } from '../features/networks/network-statistics';
import { useNetworkEntries } from '../features/networks/network-community-list';
import {
  buildNetworkRoute,
  captureNetworkListPosition,
  readNetworkListPosition,
  readNetworkRoute,
  saveNetworkListPosition,
  type NetworkRouteState,
} from '../features/networks/network-route-state';
import './networks-page.css';

const NetworkStatisticsView = lazy(async () => ({
  default: (await import('../features/networks/network-statistics-view')).NetworkStatisticsView,
}));
const NetworkCompositionSheet = lazy(async () => ({
  default: (await import('../features/networks/network-composition-sheet')).NetworkCompositionSheet,
}));
const categoryIcons: Record<ManagedEntityFavoriteType, AppIconName> = {
  important: 'Star',
  watch: 'ShieldCheck',
  broadcast: 'SendDiagonal',
  test: 'Flask',
  partner: 'Group',
  service: 'Wrench',
};
const compactNumber = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat('ru-RU');
const countForms = new Intl.PluralRules('ru-RU');
function formatEntityCount(count: number, type: ManagedEntityType): string {
  const form = countForms.select(count);
  const noun =
    type === 'chat'
      ? form === 'one'
        ? 'чат'
        : form === 'few'
          ? 'чата'
          : 'чатов'
      : form === 'one'
        ? 'канал'
        : form === 'few'
          ? 'канала'
          : 'каналов';
  return `${fullNumber.format(count)} ${noun}`;
}
function Metric({
  label,
  value,
  growth = false,
}: {
  label: string;
  value: number | null | undefined;
  growth?: boolean;
}) {
  const formatted =
    value == null ? '—' : `${growth && value > 0 ? '+' : ''}${compactNumber.format(value)}`;
  return (
    <div className="network-card-metric">
      <span>{label}</span>
      <strong
        className={
          growth && value != null && value !== 0
            ? value > 0
              ? 'is-positive'
              : 'is-negative'
            : undefined
        }
        title={value == null ? 'Нет подтверждённых данных' : fullNumber.format(value)}
      >
        {formatted}
      </strong>
    </div>
  );
}
function SummaryCard({
  api,
  scopeKey,
  type,
  card,
  range,
  stale,
  onOpen,
  onSettings,
  onRefresh,
}: {
  api: ApiTransport;
  scopeKey: string;
  type: ManagedEntityType;
  card: ManagedEntityNetworkCard;
  range: NetworkRouteState['range'];
  stale: boolean;
  onOpen: () => void;
  onSettings: () => void;
  onRefresh: () => Promise<void>;
}) {
  const stats = useNetworkStatistics({
    api,
    scopeKey,
    entityType: type,
    favoriteType: card.favoriteType,
    range,
    compositionVersion: card.compositionVersion,
    enabled: !stale && card.entityCount > 0,
    onScopeInvalidated: () => {
      void onRefresh().catch(() => undefined);
    },
  });
  return (
    <article className="network-summary-card" data-network-category={card.favoriteType}>
      <div className="network-summary-card__body">
        <div className="network-summary-card__head">
          <span className="network-category-icon">
            <AppIcon icon={categoryIcons[card.favoriteType]} />
          </span>
          <div>
            <h2>{card.label}</h2>
            <small>{formatEntityCount(card.entityCount, type)}</small>
          </div>
        </div>
        <div className="network-summary-card__metrics">
          <Metric
            label={type === 'chat' ? 'Участники' : 'Подписчики'}
            value={stats.data?.audience.value}
          />
          <Metric
            label={`Прирост · ${range === '7d' ? 7 : 30} дн.`}
            value={stats.data?.netGrowth.value}
            growth
          />
        </div>
        {stats.phase !== 'settled' ||
        stats.data?.audience.coverage.status !== 'ready' ||
        stats.data?.netGrowth.coverage.status !== 'ready' ? (
          <p className="network-summary-card__status" role="status">
            {stats.phase === 'checking'
              ? 'Проверяем доступ…'
              : stats.phase === 'loading' || stats.phase === 'idle'
                ? 'Загружаем данные…'
                : stats.phase === 'error' || stats.phase === 'stale'
                  ? 'Данные временно недоступны'
                  : stats.data?.audience.coverage.status !== 'ready' ||
                      stats.data?.netGrowth.coverage.status !== 'ready'
                    ? 'Частичные данные'
                    : null}
          </p>
        ) : null}
      </div>
      <div className="network-summary-card__actions">
        <button
          type="button"
          className="networks-secondary network-summary-card__open"
          onClick={onOpen}
        >
          <AppIcon icon="StatsUpSquare" />
          Статистика
        </button>
        <button type="button" className="networks-primary" disabled={stale} onClick={onSettings}>
          <AppIcon icon="Settings" />
          Настройки
        </button>
      </div>
      {stats.phase === 'error' || stats.phase === 'stale' ? (
        <button type="button" className="networks-text-button" onClick={stats.refresh}>
          Обновить сводку
        </button>
      ) : null}
    </article>
  );
}

function OperationResumes({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const [receipts, setReceipts] = useState<NetworkSettingsOperationReceipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void import('../lib/network-settings-operation-storage')
      .then(({ hydrateNetworkSettingsOperationReceipts }) =>
        hydrateNetworkSettingsOperationReceipts(userId),
      )
      .then((value) => {
        if (active) setReceipts(value);
      });
    return () => {
      active = false;
    };
  }, [userId]);
  const open = async (receipt: NetworkSettingsOperationReceipt) => {
    setError(null);
    const { hydrateNetworkSettingsScope } = await import('../lib/network-settings-workspace-state');
    const scope = await hydrateNetworkSettingsScope({
      userId,
      scopeId: receipt.scopeId,
      entityType: receipt.entityType,
    });
    if (!scope) {
      setError('Не удалось восстановить выбор сообществ. Результат операции не изменён.');
      return;
    }
    navigate(
      `/networks/${receipt.entityType}/settings/${receipt.section}?${new URLSearchParams({ scope: receipt.scopeId, operation: receipt.operationId })}`,
    );
  };
  const pending = receipts.filter((receipt) => receipt.lastKnownStatus !== 'COMPLETE').slice(0, 5);
  if (!pending.length) return null;
  return (
    <section className="networks-resumes" aria-label="Сохранённые операции">
      <h2>Изменения настроек</h2>
      {pending.map((receipt) => (
        <button
          type="button"
          key={receipt.operationId}
          onClick={() =>
            void open(receipt).catch(() =>
              setError('Не удалось открыть результат. Повторите попытку.'),
            )
          }
        >
          <AppIcon icon="RefreshDouble" />
          <span>
            <strong>{receipt.title}</strong>
            <small>
              {receipt.launchState === 'unconfirmed'
                ? 'Проверить предпросмотр'
                : 'Посмотреть ход применения'}
            </small>
          </span>
          <AppIcon icon="NavArrowRight" />
        </button>
      ))}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function NetworkDetail({
  api,
  state,
  card,
  stale,
  onRoute,
  refresh,
  onSettings,
}: {
  api: ApiTransport;
  state: NetworkRouteState;
  card: ManagedEntityNetworkCard;
  stale: boolean;
  onRoute: (next: NetworkRouteState) => void;
  refresh: () => Promise<void>;
  onSettings: (pageCount: number) => void;
}) {
  const { snapshot } = useHomeEntityFavorites();
  const [compositionOpen, setCompositionOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const compositionEpoch = snapshot.byType[state.entityType].compositionEpoch;
  const initialPosition = useRef(readNetworkListPosition(snapshot.actor.scope, state));
  const entries = useNetworkEntries({
    api,
    scopeKey: snapshot.actor.scope,
    entityType: state.entityType,
    favoriteType: card.favoriteType,
    compositionEpoch,
    initialPageCount: initialPosition.current.loadedPageCount,
  });
  const latest = useRef({ state, pageCount: entries.pageCount });
  latest.current = { state, pageCount: entries.pageCount };
  const stats = useNetworkStatistics({
    api,
    scopeKey: snapshot.actor.scope,
    entityType: state.entityType,
    favoriteType: card.favoriteType,
    range: state.range,
    compositionVersion: card.compositionVersion,
    enabled: !stale && state.tab === 'overview',
    onScopeInvalidated: () => {
      void refresh().catch(() => setNotice('Состав изменился. Обновите сетку.'));
    },
  });
  const savePosition = () =>
    saveNetworkListPosition(
      snapshot.actor.scope,
      latest.current.state,
      captureNetworkListPosition(Math.max(1, latest.current.pageCount)),
    );
  useLayoutEffect(
    () => () => {
      saveNetworkListPosition(
        snapshot.actor.scope,
        latest.current.state,
        captureNetworkListPosition(Math.max(1, latest.current.pageCount)),
      );
    },
    [snapshot.actor.scope],
  );
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (
      restored.current ||
      state.tab !== 'communities' ||
      entries.loading ||
      entries.error ||
      entries.pageCount === 0 ||
      (entries.pageCount < initialPosition.current.loadedPageCount && entries.nextCursor)
    )
      return;
    restored.current = true;
    const position = initialPosition.current;
    const frame = window.requestAnimationFrame(() => {
      const row = position.anchor
        ? [...document.querySelectorAll<HTMLElement>('[data-network-entity-id]')].find(
            (node) => node.dataset.networkEntityId === position.anchor?.entityId,
          )
        : null;
      window.scrollTo({
        top:
          row && position.anchor
            ? window.scrollY + row.getBoundingClientRect().top - position.anchor.offset
            : position.scrollY,
        behavior: 'instant',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries.error, entries.loading, entries.nextCursor, entries.pageCount, state.tab]);
  useNativeBackHandler(
    () => {
      savePosition();
      onRoute({ ...state, favoriteType: null, tab: 'overview' });
      return true;
    },
    { enabled: !compositionOpen, priority: 100 },
  );
  const route = (next: NetworkRouteState) => {
    savePosition();
    onRoute(next);
  };
  const openSettings = () => {
    savePosition();
    onSettings(Math.max(1, entries.pageCount));
  };
  return (
    <>
      <div className="network-detail-navigation">
        <button
          type="button"
          className="networks-back"
          onClick={() => route({ ...state, favoriteType: null, tab: 'overview' })}
        >
          <AppIcon icon="NavArrowLeft" />
          Все сетки
        </button>
        <SegmentedControl
          value={state.range}
          options={[
            { value: '7d', label: '7 дней' },
            { value: '30d', label: '30 дней' },
          ]}
          onChange={(range) => route({ ...state, range })}
          ariaLabel="Период статистики"
          className="network-range"
        />
      </div>
      <div className="network-detail-toolbar">
        <SegmentedControl
          value={state.tab}
          options={[
            { value: 'overview', label: 'Статистика' },
            { value: 'communities', label: 'Состав', count: card.entityCount },
          ]}
          onChange={(tab) => route({ ...state, tab })}
          ariaLabel="Раздел сетки"
          className="network-tabs"
        />
        <button
          type="button"
          className="networks-primary network-detail-settings"
          disabled={stale || card.entityCount === 0}
          onClick={openSettings}
        >
          <AppIcon icon="Settings" />
          Настройки
        </button>
      </div>
      {notice ? (
        <div className="networks-notice" role="status">
          {notice}
        </div>
      ) : null}
      {stale ? (
        <div className="networks-notice" role="status">
          <span>Обновляем состав сетки…</span>
          <button
            type="button"
            onClick={() =>
              void refresh().catch(() => setNotice('Обновить состав пока не удалось.'))
            }
          >
            Обновить
          </button>
        </div>
      ) : null}
      {state.tab === 'overview' ? (
        <Suspense
          fallback={
            <div className="networks-loading">
              <Spinner />
              Открываем сводку…
            </div>
          }
        >
          <NetworkStatisticsView
            state={stats}
            entityType={state.entityType}
            range={state.range}
            onOpenCommunities={() => route({ ...state, tab: 'communities' })}
          />
        </Suspense>
      ) : (
        <>
          <div className="network-community-actions">
            <span className="networks-caption">Те же избранные, что на главной</span>
            <button
              type="button"
              className="networks-secondary"
              onClick={() => setCompositionOpen(true)}
            >
              <AppIcon icon="Group" />
              Изменить состав
            </button>
          </div>
          <div className="network-community-list" aria-busy={entries.loading}>
            {entries.items.map((item) => (
              <div className="network-community-row" key={item.id} data-network-entity-id={item.id}>
                <EntityAvatar
                  title={item.title}
                  entityId={item.id}
                  entityType={item.entityType}
                  avatarUrl={item.avatarUrl}
                />
                <span className="network-community-row__text">
                  <strong>{item.title}</strong>
                  <small>{item.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
                </span>
              </div>
            ))}
            {!entries.loading && !entries.error && entries.items.length === 0 ? (
              <div className="networks-empty">
                <strong>В сетке пока пусто</strong>
                <p>Отметьте избранное на главной или измените состав здесь.</p>
              </div>
            ) : null}
            {entries.loading ? (
              <div className="networks-loading" role="status">
                <Spinner />
                Загружаем состав…
              </div>
            ) : null}
            {entries.error ? (
              <div className="networks-notice" role="alert">
                <p>{entries.error}</p>
                <button type="button" onClick={entries.refresh}>
                  Обновить список
                </button>
              </div>
            ) : null}
            {entries.nextCursor && !entries.loading && !entries.error ? (
              <button type="button" className="networks-more" onClick={entries.loadMore}>
                Показать ещё
              </button>
            ) : null}
          </div>
        </>
      )}
      {compositionOpen ? (
        <Suspense
          fallback={
            <div className="networks-loading" role="status">
              Открываем состав…
            </div>
          }
        >
          <NetworkCompositionSheet
            api={api}
            entityType={state.entityType}
            favoriteType={card.favoriteType}
            onClose={() => setCompositionOpen(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function NetworksPage({ api, userId }: { api: ApiTransport; userId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useMemo(() => readNetworkRoute(location.search), [location.search]);
  const { snapshot } = useHomeEntityFavorites();
  const catalogue = useHomeEntityNetworkCatalogue(state.entityType);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const onRoute = (next: NetworkRouteState) => navigate(buildNetworkRoute(next));
  const selectedCard = catalogue.cards.find((card) => card.favoriteType === state.favoriteType);
  useNativeBackHandler(
    () => {
      navigate(`/?view=${state.entityType}`, { replace: true });
      return true;
    },
    { enabled: !state.favoriteType, priority: 50 },
  );
  const populated = catalogue.cards.filter((card) => card.entityCount > 0);
  const emptyCards = catalogue.cards.filter((card) => card.entityCount === 0);
  const openSettings = async (
    card: ManagedEntityNetworkCard,
    returnState: NetworkRouteState,
    pageCount = 1,
  ) => {
    if (catalogue.stale || card.entityCount === 0) return;
    setSettingsError(null);
    try {
      const { createNetworkSettingsScope } =
        await import('../lib/network-settings-workspace-state');
      const target = { mode: 'category' as const, favoriteType: card.favoriteType };
      const scope =
        state.entityType === 'chat'
          ? { entityType: 'chat' as const, target, initialSection: 'links' as const }
          : { entityType: 'channel' as const, target, initialSection: 'quickButtons' as const };
      const stored = createNetworkSettingsScope({
        userId,
        scope,
        title: card.label,
        returnTo: buildNetworkRoute(returnState),
        origin: {
          locationKey: location.key,
          historyIndex:
            typeof window.history.state?.idx === 'number' ? window.history.state.idx : null,
          ...captureNetworkListPosition(pageCount),
        },
      });
      navigate(
        `/networks/${scope.entityType}/settings?${new URLSearchParams({ scope: stored.scopeId })}`,
      );
    } catch {
      setSettingsError('Не удалось открыть настройки сетки. Повторите попытку.');
    }
  };
  return (
    <section className="networks-page">
      <header className="networks-heading">
        <div>
          <h1>{selectedCard ? selectedCard.label : 'Сетки'}</h1>
          <p>
            {selectedCard
              ? formatEntityCount(selectedCard.entityCount, state.entityType)
              : 'Ваши избранные с главной'}
          </p>
        </div>
        {selectedCard ? (
          <label className="network-picker" data-network-category={selectedCard.favoriteType}>
            <AppIcon icon={categoryIcons[selectedCard.favoriteType]} />
            <AppIcon icon="NavArrowRight" />
            <select
              aria-label="Переключить сетку"
              value={selectedCard.favoriteType}
              onChange={(event) =>
                onRoute({ ...state, favoriteType: event.target.value as ManagedEntityFavoriteType })
              }
            >
              {catalogue.cards.map((item) => (
                <option key={item.favoriteType} value={item.favoriteType}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="networks-heading__icon">
            <AppIcon icon="Community" />
          </span>
        )}
      </header>
      {!selectedCard ? (
        <div className="networks-controls">
          <SegmentedControl
            value={state.entityType}
            options={[
              { value: 'chat', label: 'Чаты' },
              { value: 'channel', label: 'Каналы' },
            ]}
            onChange={(entityType) =>
              onRoute({ ...state, entityType, favoriteType: null, tab: 'overview' })
            }
            ariaLabel="Тип сообществ"
          />
          <SegmentedControl
            value={state.range}
            options={[
              { value: '7d', label: '7 дней' },
              { value: '30d', label: '30 дней' },
            ]}
            onChange={(range) => onRoute({ ...state, range })}
            ariaLabel="Период статистики"
          />
        </div>
      ) : null}
      {settingsError ? (
        <p className="networks-notice" role="alert">
          {settingsError}
        </p>
      ) : null}
      {catalogue.status === 'loading' && catalogue.cards.length === 0 ? (
        <div className="networks-loading" role="status">
          <Spinner />
          <span>Загружаем сетки…</span>
        </div>
      ) : null}
      {catalogue.error ? (
        <div className="networks-notice" role="alert">
          <p>Не удалось обновить сетки. Сохранённые данные могут быть неактуальны.</p>
          <button type="button" onClick={() => void catalogue.refresh().catch(() => undefined)}>
            Повторить
          </button>
        </div>
      ) : null}
      {state.favoriteType && selectedCard ? (
        <NetworkDetail
          key={`${state.entityType}:${state.favoriteType}`}
          api={api}
          state={state}
          card={selectedCard}
          stale={catalogue.stale}
          onRoute={onRoute}
          refresh={catalogue.refresh}
          onSettings={(pageCount) => void openSettings(selectedCard, state, pageCount)}
        />
      ) : !state.favoriteType ? (
        <>
          <OperationResumes key={userId} userId={userId} />
          <div className="networks-catalogue">
            {populated.map((card) => (
              <SummaryCard
                key={`${state.entityType}:${card.favoriteType}`}
                api={api}
                scopeKey={snapshot.actor.scope}
                type={state.entityType}
                card={card}
                range={state.range}
                stale={catalogue.stale}
                onRefresh={catalogue.refresh}
                onSettings={() => void openSettings(card, state)}
                onOpen={() =>
                  onRoute({ ...state, favoriteType: card.favoriteType, tab: 'overview' })
                }
              />
            ))}
          </div>
          {emptyCards.length ? (
            <details className="networks-empty-categories" open={!populated.length}>
              <summary>{populated.length ? 'Пустые сетки' : 'Добавьте избранное в сетку'}</summary>
              {!populated.length ? (
                <p>Отметьте чаты и каналы на главной — они появятся здесь.</p>
              ) : null}
              <div>
                {emptyCards.map((card) => (
                  <button
                    type="button"
                    key={card.favoriteType}
                    data-network-category={card.favoriteType}
                    onClick={() =>
                      onRoute({ ...state, favoriteType: card.favoriteType, tab: 'communities' })
                    }
                  >
                    <AppIcon icon={categoryIcons[card.favoriteType]} />
                    <span>{card.label}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="networks-text-button"
                onClick={() => navigate(`/?view=${state.entityType}`)}
              >
                <AppIcon icon="Star" />К избранному на главной
              </button>
            </details>
          ) : null}
        </>
      ) : catalogue.status !== 'loading' ? (
        <div className="networks-notice">
          <p>Сетка пока недоступна.</p>
          <button type="button" onClick={() => onRoute({ ...state, favoriteType: null })}>
            Все сетки
          </button>
        </div>
      ) : null}
    </section>
  );
}
