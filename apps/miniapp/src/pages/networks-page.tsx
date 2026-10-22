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
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import { useHomeEntityNetworkCatalogue } from '../lib/home-entity-networks-context';
import type { NetworkSettingsOperationReceipt } from '../lib/network-settings-operation-storage';
import { useNativeBackHandler } from '../lib/native-back';
import { useNetworkStatistics } from '../features/networks/network-statistics';
import {
  NetworkCommunityList,
  useNetworkEntries,
} from '../features/networks/network-community-list';
import {
  buildNetworkRoute,
  captureNetworkListPosition,
  networkSelectionTarget,
  readNetworkListPosition,
  readNetworkRoute,
  saveNetworkListPosition,
  toggleNetworkRecipient,
  readNetworkRecipientSelection,
  saveNetworkRecipientSelection,
  type NetworkRecipientSelection,
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
  onRefresh,
}: {
  api: ApiTransport;
  scopeKey: string;
  type: ManagedEntityType;
  card: ManagedEntityNetworkCard;
  range: NetworkRouteState['range'];
  stale: boolean;
  onOpen: () => void;
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
    <article className="network-summary-card">
      <button type="button" className="network-summary-card__open" onClick={onOpen}>
        <span className="network-summary-card__head">
          <span className="network-category-icon">
            <AppIcon icon={categoryIcons[card.favoriteType]} />
          </span>
          <span>
            <strong>{card.label}</strong>
            <small>{formatEntityCount(card.entityCount, type)}</small>
          </span>
          <AppIcon icon="NavArrowRight" />
        </span>
        <span className="network-summary-card__metrics">
          <Metric
            label={type === 'chat' ? 'Участники' : 'Подписчики'}
            value={stats.data?.audience.value}
          />
          <Metric
            label={`Прирост · ${range === '7d' ? 7 : 30} дн.`}
            value={stats.data?.netGrowth.value}
            growth
          />
        </span>
        <span className="network-summary-card__foot">
          <span>
            {stats.phase === 'checking'
              ? 'Проверяем доступ…'
              : stats.phase === 'loading' || stats.phase === 'idle'
                ? 'Загружаем данные…'
                : stats.phase === 'error' || stats.phase === 'stale'
                  ? 'Данные временно недоступны'
                  : stats.data?.audience.coverage.status !== 'ready' ||
                      stats.data?.netGrowth.coverage.status !== 'ready'
                    ? 'Неполное покрытие'
                    : 'Сводка сетки'}
          </span>
          <AppIcon icon="StatsUpSquare" />
        </span>
      </button>
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
  userId,
  state,
  card,
  cards,
  stale,
  onRoute,
  refresh,
}: {
  api: ApiTransport;
  userId: string;
  state: NetworkRouteState;
  card: ManagedEntityNetworkCard;
  cards: readonly ManagedEntityNetworkCard[];
  stale: boolean;
  onRoute: (next: NetworkRouteState) => void;
  refresh: () => Promise<void>;
}) {
  const { snapshot } = useHomeEntityFavorites();
  const location = useLocation();
  const navigate = useNavigate();
  const [selection, setSelection] = useState<NetworkRecipientSelection>(() =>
    readNetworkRecipientSelection(snapshot.actor.scope, state, card.compositionVersion),
  );
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
  const previousEpoch = useRef(compositionEpoch);
  useEffect(() => {
    if (previousEpoch.current !== compositionEpoch) {
      previousEpoch.current = compositionEpoch;
      setSelection({ mode: 'selected', entityIds: [] });
      setNotice('Состав обновлён. Выберите получателей заново.');
    }
  }, [compositionEpoch]);
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
  const target = networkSelectionTarget(selection, card.favoriteType);
  const selectedCount =
    selection.mode === 'category' ? card.entityCount : selection.entityIds.length;
  const openSettings = async () => {
    if (!target || stale || selectedCount === 0) return;
    savePosition();
    saveNetworkRecipientSelection(snapshot.actor.scope, state, card.compositionVersion, selection);
    try {
      const origin = {
        locationKey: location.key,
        historyIndex:
          typeof window.history.state?.idx === 'number' ? window.history.state.idx : null,
        ...captureNetworkListPosition(Math.max(1, entries.pageCount)),
      };
      const scope =
        state.entityType === 'chat'
          ? { entityType: 'chat' as const, target, initialSection: 'links' as const }
          : { entityType: 'channel' as const, target, initialSection: 'quickButtons' as const };
      const { createNetworkSettingsScope } =
        await import('../lib/network-settings-workspace-state');
      const stored = createNetworkSettingsScope({
        userId,
        scope,
        title: card.label,
        returnTo: buildNetworkRoute({ ...state, tab: 'communities' }),
        origin,
      });
      navigate(
        `/networks/${state.entityType}/settings?${new URLSearchParams({ scope: stored.scopeId })}`,
      );
    } catch {
      setNotice(
        'Не удалось сохранить выбор на устройстве. Настройки не открыты. Повторите попытку.',
      );
    }
  };
  return (
    <>
      <div className="network-detail-heading">
        <button
          type="button"
          className="networks-back"
          onClick={() => route({ ...state, favoriteType: null, tab: 'overview' })}
        >
          <AppIcon icon="NavArrowLeft" />
          Все сетки
        </button>
        <label className="network-picker">
          <AppIcon icon={categoryIcons[card.favoriteType]} />
          <select
            aria-label="Переключить сетку"
            value={card.favoriteType}
            onChange={(event) =>
              route({ ...state, favoriteType: event.target.value as ManagedEntityFavoriteType })
            }
          >
            {cards.map((item) => (
              <option key={item.favoriteType} value={item.favoriteType}>
                {item.label} · {item.entityCount}
              </option>
            ))}
          </select>
        </label>
      </div>
      <SegmentedControl
        value={state.tab}
        options={[
          { value: 'overview', label: 'Обзор' },
          { value: 'communities', label: 'Сообщества', count: card.entityCount },
        ]}
        onChange={(tab) => route({ ...state, tab })}
        ariaLabel="Раздел сетки"
        className="network-tabs"
      />
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
          <div className="network-selection-panel">
            <label>
              <input
                type="checkbox"
                checked={selection.mode === 'category'}
                disabled={stale || card.entityCount === 0}
                onChange={(event) =>
                  setSelection(
                    event.target.checked
                      ? { mode: 'category' }
                      : { mode: 'selected', entityIds: [] },
                  )
                }
              />
              <span>
                <strong>Выбрать всю сетку</strong>
                <small>
                  Все {fullNumber.format(card.entityCount)} · включая следующие страницы
                </small>
              </span>
            </label>
            {selection.mode === 'category' ? (
              <button
                type="button"
                className="networks-text-button"
                onClick={() => setSelection({ mode: 'selected', entityIds: [] })}
              >
                Выбрать отдельные сообщества
              </button>
            ) : (
              <small className="networks-caption">
                Выбрано {selectedCount}
                {selectedCount >= 500 ? ' · максимум 500 за один выбор' : ''}
              </small>
            )}
          </div>
          <div className="network-community-actions">
            <button
              type="button"
              className="networks-secondary"
              onClick={() => setCompositionOpen(true)}
            >
              <AppIcon icon="Group" />
              Изменить состав
            </button>
            <button
              type="button"
              className="networks-primary"
              disabled={!target || stale || selectedCount === 0}
              onClick={openSettings}
            >
              <AppIcon icon="Settings" />
              Настроить{selectedCount ? ` · ${fullNumber.format(selectedCount)}` : ''}
            </button>
          </div>
          <NetworkCommunityList
            entries={entries}
            selection={selection}
            onToggle={(id) => setSelection((current) => toggleNetworkRecipient(current, id))}
          />
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
  return (
    <section className="networks-page">
      <header className="networks-heading">
        <div>
          <span className="networks-eyebrow">МАЙОР · ИЗБРАННОЕ</span>
          <h1>{selectedCard ? selectedCard.label : 'Сетки'}</h1>
          <p>
            {selectedCard
              ? `${formatEntityCount(selectedCard.entityCount, state.entityType)} · общая сводка`
              : 'Ваши сообщества. Общая картина.'}
          </p>
        </div>
        <span className="networks-heading__icon">
          <AppIcon icon="Community" />
        </span>
      </header>
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
          userId={userId}
          state={state}
          card={selectedCard}
          cards={catalogue.cards}
          stale={catalogue.stale}
          onRoute={onRoute}
          refresh={catalogue.refresh}
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
                onOpen={() =>
                  onRoute({ ...state, favoriteType: card.favoriteType, tab: 'overview' })
                }
              />
            ))}
          </div>
          {emptyCards.length ? (
            <section className="networks-empty-categories">
              <h2>{populated.length ? 'Другие сетки' : 'Соберите первую сетку'}</h2>
              {!populated.length ? (
                <p>
                  Категории уже связаны с избранным на главной. Выберите одну и добавьте сообщества.
                </p>
              ) : null}
              <div>
                {emptyCards.map((card) => (
                  <button
                    type="button"
                    key={card.favoriteType}
                    onClick={() =>
                      onRoute({ ...state, favoriteType: card.favoriteType, tab: 'communities' })
                    }
                  >
                    <AppIcon icon={categoryIcons[card.favoriteType]} />
                    <span>{card.label}</span>
                    <small>0</small>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <p className="networks-caption networks-footnote">
            Сводки рассчитаны по текущему составу сеток. Отсутствующие наблюдения отмечаются
            отдельно.
          </p>
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
