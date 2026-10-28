import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  karavanMarketplaceCategories,
  karavanMarketplaceSetupSchema,
  type KaravanMarketplaceSetup,
  type KaravanMarketplaceOperation,
  type KaravanMarketplaceHandoffDestination,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getAvailableKaravanMarketplaces,
  getKaravanMarketplace,
  getKaravanMarketplaceOperation,
  setupKaravanMarketplace,
  openKaravanMarketplace,
} from '../../lib/api/karavan-marketplace-client';
import {
  hydrateMirroredItem,
  saveMirroredItem,
  removeMirroredItem,
} from '../../lib/native-storage';
import { openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { ApiRequestError } from '../../lib/api-request-error';
import { describeUserFacingError } from '../../lib/user-facing-error';
import { useNativeBackHandler } from '../../lib/native-back';
import { useKaravanMarketplaceBinding } from './use-karavan-marketplace-binding';
import { Spinner } from '../../components/ui/spinner';
import '../../styles/karavan-marketplace.css';

const russianPlural = new Intl.PluralRules('ru');
function countLabel(count: number, one: string, few: string, many: string) {
  const form = russianPlural.select(count);
  return form === 'one' ? one : form === 'few' ? few : many;
}

const marketplaceSafe = (value: { marketplace: unknown } | null) => !!value?.marketplace;
const defaultRules =
  'Продавец отвечает за описание, актуальность товаров и выполнение договорённостей. Размещение витрин — после проверки администратора. Запрещены товары и услуги, нарушающие закон и правила MAX.';

export default function KaravanMarketplacePanel({
  api,
  chatId,
}: {
  api: ApiTransport;
  chatId: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['karavan-marketplace', chatId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getKaravanMarketplace(api, chatId, signal),
    staleTime: 15_000,
    retry: false,
  });
  const [step, setStep] = useState<'intro' | 'name' | 'confirm' | 'existing'>('intro');
  const [name, setName] = useState('');
  const [rules, setRules] = useState(defaultRules);
  const [categories, setCategories] = useState<string[]>(
    karavanMarketplaceCategories.map(([id]) => id),
  );
  const [selectedChats, setSelectedChats] = useState([chatId]);
  const [showChats, setShowChats] = useState(false);
  const [saved, setSaved] = useState<KaravanMarketplaceSetup | null>(null);
  const [operation, setOperation] = useState<KaravanMarketplaceOperation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const module = query.data?.enabled ? query.data : null;
  const storageKey = module ? `karavan-setup:v1:${module.actorMaxUserId}:${chatId}` : null;
  const bind = useKaravanMarketplaceBinding(api, chatId, module?.actorMaxUserId);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const available = useInfiniteQuery({
    queryKey: ['karavan-available', chatId],
    enabled: step === 'existing',
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => getAvailableKaravanMarketplaces(api, chatId, pageParam),
    getNextPageParam: (page) => page.nextCursor,
    retry: false,
  });
  const chats = useQuery({
    queryKey: ['karavan-setup-chats'],
    enabled: showChats || !!saved,
    queryFn: async () => (await import('../../lib/api/root-client')).getChats(api),
    staleTime: 30_000,
    retry: false,
  });

  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    setHydrated(false);
    const restored = module?.setupOperation;
    void hydrateMirroredItem(storageKey)
      .then(async (raw) => {
        if (!active) return;
        if (restored) {
          setSaved(restored.request);
          setOperation(restored);
          saveMirroredItem(storageKey, JSON.stringify(restored.request));
          if (restored.state === 'complete') {
            removeMirroredItem(storageKey);
            setSaved(null);
          }
        } else if (raw) {
          try {
            const input = karavanMarketplaceSetupSchema.parse(JSON.parse(raw));
            if (!input.chatIds.includes(chatId)) throw new Error('Chat changed');
            setSaved(input);
            const state = await getKaravanMarketplaceOperation(api, chatId, input.operationId);
            if (!active) return;
            setOperation(state);
            if (state.state === 'complete') {
              removeMirroredItem(storageKey);
              setSaved(null);
              void queryClient.invalidateQueries({ queryKey });
            }
          } catch {
            if (active)
              setNotice('Не удалось проверить предыдущее подключение. Повторите проверку.');
          }
        }
        if (active) setHydrated(true);
      })
      .catch(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, [storageKey, api, chatId, module?.setupOperation?.operationId]);

  const setup = useMutation({
    mutationFn: (input: KaravanMarketplaceSetup) => setupKaravanMarketplace(api, chatId, input),
    onSuccess: (state) => {
      setOperation(state);
      setSaved(state.request);
      if (storageKey) saveMirroredItem(storageKey, JSON.stringify(state.request));
      setNotice(null);
      if (state.state === 'complete') {
        if (storageKey) removeMirroredItem(storageKey);
        setSaved(null);
        setStep('intro');
        void queryClient.invalidateQueries({ queryKey });
      }
    },
    onError: (error) => {
      setNotice(
        describeUserFacingError(
          error,
          'Результат пока не подтверждён. Повторите проверку подключения.',
        ),
      );
      if (error instanceof ApiRequestError && error.code === 'KARAVAN_SETUP_IN_PROGRESS')
        void queryClient.invalidateQueries({ queryKey });
    },
  });
  useEffect(() => {
    if (operation?.state !== 'pending' || !saved || setup.isPending) return;
    const timer = window.setTimeout(() => setup.mutate(saved), 1200);
    return () => window.clearTimeout(timer);
  }, [operation, saved, setup.isPending]);
  useNativeBackHandler(
    () => {
      if (saved || setup.isPending || bind.isPending || bind.request) return false;
      setStep(step === 'confirm' ? 'name' : 'intro');
      return true;
    },
    {
      enabled: step === 'existing' || (step !== 'intro' && !marketplaceSafe(module)),
      priority: 620,
    },
  );
  const handoff = useMutation({
    mutationFn: (destination: KaravanMarketplaceHandoffDestination) =>
      openKaravanMarketplace(api, chatId, module!.marketplace!.id, destination),
    onSuccess: (result) => {
      if (!openMaxBotLinkAndClose(result.url)) setNotice('Откройте магазин из MAX.');
    },
    onError: (error) =>
      setNotice(describeUserFacingError(error, 'Не удалось открыть магазин. Повторите попытку.')),
  });
  function start() {
    if (!storageKey) return;
    if (saved) {
      setup.mutate(saved);
      return;
    }
    const parsed = karavanMarketplaceSetupSchema.safeParse({
      operationId: crypto.randomUUID(),
      chatIds: selectedChats,
      create: {
        name,
        rules: {
          text: rules,
          allowedCategoryIds: categories,
          allowedSubcategoryIds: [],
          categoryOrder: categories,
        },
      },
    });
    if (!parsed.success) {
      setNotice('Проверьте название, правила и выберите хотя бы одну категорию.');
      return;
    }
    saveMirroredItem(storageKey, JSON.stringify(parsed.data));
    setSaved(parsed.data);
    setNotice(null);
    setup.mutate(parsed.data);
  }
  if (query.data?.enabled === false) return null;
  if (query.isPending)
    return (
      <div className="karavan-module" role="status">
        <Spinner size="sm" label="Проверяем магазин" />
      </div>
    );
  if (query.isError)
    return (
      <section className="karavan-module">
        <p role="alert">Не удалось проверить магазин.</p>
        <button type="button" onClick={() => void query.refetch()}>
          Повторить
        </button>
      </section>
    );
  if (!module) return null;
  const marketplace = module.marketplace;
  const active = marketplace?.status === 'active';
  const canReview = module.permissions.includes('review_listing');
  const canManage = module.permissions.includes('manage_marketplace');
  const canOpen = module.permissions.length > 0;
  const canBind = module.permissions.includes('bind_chat');
  const busy = handoff.isPending || bind.isPending;
  const ready = hydrated && bind.hydrated;
  const startBinding = (action: 'unbind_chat' | 'recover_chat') => {
    if (!marketplace || !module.binding) return;
    setDisconnectConfirm(false);
    bind.start({
      marketplaceId: marketplace.id,
      action,
      expectedBindingGeneration: module.binding.generation,
    });
  };
  return (
    <section className="karavan-module" aria-label="Магазин чата">
      {notice || bind.error ? (
        <p className="karavan-module__notice" role="alert">
          {notice || bind.error}
        </p>
      ) : null}
      {bind.request ? (
        <>
          <h3>
            {bind.request.action === 'unbind_chat' ? 'Отключение чата' : 'Подключение магазина'}
          </h3>
          <p>
            {bind.isPending
              ? 'Проверяем результат…'
              : bind.rejected
                ? 'Изменение не выполнено.'
                : 'Результат изменения ещё не подтверждён.'}
          </p>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={bind.isPending}
            onClick={bind.retry}
          >
            {bind.isPending ? 'Проверяем…' : 'Повторить проверку'}
          </button>
          {bind.rejected ? (
            <button
              type="button"
              onClick={() => {
                bind.resetRejected();
                setStep('intro');
              }}
            >
              Обновить состояние
            </button>
          ) : null}
        </>
      ) : saved || setup.isPending ? (
        <>
          <h3>Подключение магазина</h3>
          <p>
            {setup.isPending
              ? 'Проверяем права и подключаем выбранные чаты…'
              : operation?.state === 'unknown'
                ? 'Результат создания ещё не подтверждён.'
                : 'Часть подключения требует проверки.'}
          </p>
          {operation ? (
            <ul className="karavan-module__progress">
              {operation.checkpoints.bindings.map((item) => (
                <li key={item.chatId}>
                  <span>
                    {chats.data?.find((chat) => chat.id === item.chatId)?.title ??
                      (item.chatId === chatId ? 'Этот чат' : 'Выбранный чат')}
                  </span>
                  <strong>
                    {
                      {
                        pending: 'Ожидает',
                        connected: 'Подключён',
                        unknown: 'Проверяется',
                        failed: 'Нужна проверка',
                      }[item.state]
                    }
                  </strong>
                </li>
              ))}
            </ul>
          ) : null}
          {operation?.state !== 'rejected' ? (
            <button
              type="button"
              className="karavan-module__primary"
              disabled={setup.isPending || !ready}
              onClick={start}
            >
              {setup.isPending ? 'Подключаем…' : 'Продолжить подключение'}
            </button>
          ) : null}
          {operation?.state === 'rejected' && !operation.checkpoints.marketplaceId && saved ? (
            <button
              type="button"
              onClick={() => {
                setName(saved.create.name);
                setRules(saved.create.rules.text);
                setCategories(saved.create.rules.allowedCategoryIds);
                setSelectedChats(saved.chatIds);
                if (storageKey) removeMirroredItem(storageKey);
                setSaved(null);
                setOperation(null);
                setNotice(null);
                setStep('confirm');
              }}
            >
              Изменить настройки
            </button>
          ) : null}
          {operation?.checkpoints.marketplaceId ? (
            <button
              type="button"
              onClick={() => {
                const url = new URL(module.sellerBotUrl);
                url.searchParams.set(
                  'startapp',
                  `community_${operation.checkpoints.marketplaceId}`,
                );
                if (!openMaxBotLinkAndClose(url.toString())) setNotice('Откройте магазин из MAX.');
              }}
            >
              Настроить черновик
            </button>
          ) : null}
        </>
      ) : marketplace && step !== 'existing' ? (
        <>
          <div className="karavan-module__identity">
            <span className="karavan-module__eyebrow">Магазин чата</span>
            <h3>{marketplace.name}</h3>
            <p>
              {active
                ? 'Открыт для покупателей'
                : marketplace.status === 'draft'
                  ? 'Черновик · магазин ещё не открыт'
                  : marketplace.status === 'paused'
                    ? 'Показ покупателям приостановлен'
                    : 'Магазин в архиве'}
            </p>
          </div>
          <div className="karavan-module__metrics">
            <span>
              <strong>{module.counts.listings}</strong>
              <span>{countLabel(module.counts.listings, 'витрина', 'витрины', 'витрин')}</span>
            </span>
            <span>
              <strong>{module.counts.pendingApplications}</strong>
              <span>
                {countLabel(module.counts.pendingApplications, 'заявка', 'заявки', 'заявок')}
              </span>
            </span>
            <span>
              <strong>{module.counts.chats}</strong>
              <span>{countLabel(module.counts.chats, 'чат', 'чата', 'чатов')}</span>
            </span>
          </div>
          {module.binding?.state !== 'verified' ? (
            <>
              <p role="status">
                {module.binding?.state === 'disconnected'
                  ? 'Чат отключён от магазина.'
                  : 'Подключение чата требует восстановления.'}
              </p>
              {canBind && marketplace.status !== 'archived' ? (
                <button
                  type="button"
                  className="karavan-module__primary"
                  disabled={busy || !ready}
                  onClick={() => startBinding('recover_chat')}
                >
                  Восстановить подключение
                </button>
              ) : null}
            </>
          ) : null}
          {canOpen && module.binding?.state === 'verified' ? (
            <>
              <button
                type="button"
                className="karavan-module__primary"
                disabled={handoff.isPending}
                onClick={() =>
                  handoff.mutate(
                    !canManage && canReview
                      ? 'applications'
                      : canManage && marketplace.status === 'draft'
                        ? 'invite_sellers'
                        : 'manage',
                  )
                }
              >
                {handoff.isPending
                  ? 'Открываем…'
                  : !canManage && canReview
                    ? `Заявки · ${module.counts.pendingApplications}`
                    : canManage && marketplace.status === 'draft'
                      ? 'Пригласить продавцов'
                      : 'Управлять магазином'}
              </button>
              <div className="karavan-module__actions">
                {canManage && canReview && module.counts.pendingApplications > 0 ? (
                  <button
                    type="button"
                    disabled={handoff.isPending}
                    onClick={() => handoff.mutate('applications')}
                  >
                    Заявки · {module.counts.pendingApplications}
                  </button>
                ) : null}
                {canManage && marketplace.status !== 'archived' ? (
                  <button
                    type="button"
                    disabled={handoff.isPending}
                    onClick={() =>
                      handoff.mutate(marketplace.status === 'draft' ? 'manage' : 'invite_sellers')
                    }
                  >
                    {marketplace.status === 'draft'
                      ? 'Управлять магазином'
                      : 'Пригласить продавцов'}
                  </button>
                ) : null}
                {canManage && marketplace.status === 'draft' ? (
                  <button
                    type="button"
                    disabled={handoff.isPending}
                    onClick={() => handoff.mutate('open_marketplace')}
                  >
                    Открыть магазин
                  </button>
                ) : null}
                {canManage ? (
                  <button
                    type="button"
                    disabled={handoff.isPending}
                    onClick={() => handoff.mutate('categories')}
                  >
                    Категории и правила
                  </button>
                ) : null}
              </div>
            </>
          ) : !canOpen ? (
            <p>Попросите владельца магазина предоставить доступ к управлению.</p>
          ) : null}
          {canBind ? (
            <details>
              <summary>Подключение чата</summary>
              <div className="karavan-module__actions">
                {disconnectConfirm ? (
                  <>
                    <p>
                      Этот чат перестанет открывать магазин. Если он последний, показ магазина
                      покупателям приостановится. Витрины и заказы сохранятся.
                    </p>
                    <button
                      type="button"
                      disabled={busy || !ready}
                      onClick={() => startBinding('unbind_chat')}
                    >
                      Подтвердить отключение
                    </button>
                    <button type="button" onClick={() => setDisconnectConfirm(false)}>
                      Отмена
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={busy || !ready}
                      onClick={() => setStep('existing')}
                    >
                      Выбрать другой магазин
                    </button>
                    {module.binding?.state === 'verified' ? (
                      <button
                        type="button"
                        disabled={busy || !ready}
                        onClick={() => setDisconnectConfirm(true)}
                      >
                        Отключить этот чат
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </details>
          ) : null}
        </>
      ) : step === 'intro' ? (
        <>
          <h3>Магазин вашего чата</h3>
          <p>Продавцы подают заявки. Вы проверяете витрины и выбираете их порядок.</p>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={!ready}
            onClick={() => setStep('name')}
          >
            Создать магазин
          </button>
          <button type="button" disabled={!ready} onClick={() => setStep('existing')}>
            Подключить существующий
          </button>
        </>
      ) : step === 'existing' ? (
        <>
          <h3>Выберите магазин</h3>
          {module.binding ? (
            <p>Чат откроет выбранный магазин. Продавцы из прежнего магазина не переносятся.</p>
          ) : null}
          {available.isPending ? (
            <p>Загружаем магазины…</p>
          ) : available.isError ? (
            <>
              <p>Не удалось загрузить магазины.</p>
              <button type="button" onClick={() => void available.refetch()}>
                Повторить
              </button>
            </>
          ) : (
            available.data?.pages
              .flatMap((page) => page.marketplaces)
              .filter(
                (item) =>
                  item.permissions.includes('bind_chat') ||
                  item.permissions.includes('manage_network'),
              )
              .map((item) => (
                <button
                  type="button"
                  key={item.marketplace.id}
                  disabled={bind.isPending || !ready || item.marketplace.status === 'archived'}
                  onClick={() => {
                    bind.start({
                      marketplaceId: item.marketplace.id,
                      expectedBindingGeneration: module.binding?.generation ?? null,
                      action: module.binding
                        ? module.marketplace?.id === item.marketplace.id
                          ? 'recover_chat'
                          : 'transfer_chat'
                        : 'bind_chat',
                    });
                    setStep('intro');
                  }}
                >
                  {item.marketplace.name}
                </button>
              ))
          )}
          {available.data?.pages.every((page) =>
            page.marketplaces.every(
              (item) =>
                !item.permissions.includes('bind_chat') &&
                !item.permissions.includes('manage_network'),
            ),
          ) ? (
            <p>У вас пока нет доступных магазинов.</p>
          ) : null}
          {available.hasNextPage ? (
            <button
              type="button"
              disabled={available.isFetchingNextPage}
              onClick={() => void available.fetchNextPage()}
            >
              Показать ещё
            </button>
          ) : null}
          <button
            type="button"
            disabled={bind.isPending || !!bind.request}
            onClick={() => setStep('intro')}
          >
            Назад
          </button>
        </>
      ) : step === 'name' ? (
        <>
          <h3>Название магазина</h3>
          <label className="karavan-module__field">
            <span>Название</span>
            <input
              value={name}
              maxLength={120}
              placeholder="Например, Магазин нашего района"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={!name.trim()}
            onClick={() => setStep('confirm')}
          >
            Продолжить
          </button>
          <button type="button" onClick={() => setStep('intro')}>
            Отмена
          </button>
        </>
      ) : (
        <>
          <h3>{name}</h3>
          <p>Создадим черновик. Покупатели увидят магазин после его открытия.</p>
          <div className="karavan-module__selected-chat">Этот чат подключится к магазину</div>
          <button type="button" aria-expanded={showChats} onClick={() => setShowChats(!showChats)}>
            Добавить другие мои чаты
          </button>
          {showChats ? (
            <fieldset className="karavan-module__choices">
              <legend>Чаты одного магазина</legend>
              {chats.isPending ? (
                <p>Загружаем чаты…</p>
              ) : chats.isError ? (
                <>
                  <p>Не удалось загрузить чаты.</p>
                  <button type="button" onClick={() => void chats.refetch()}>
                    Повторить
                  </button>
                </>
              ) : (
                chats.data
                  ?.filter((chat) => chat.id !== chatId)
                  .map((chat) => (
                    <label key={chat.id}>
                      <input
                        type="checkbox"
                        checked={selectedChats.includes(chat.id)}
                        disabled={!selectedChats.includes(chat.id) && selectedChats.length >= 20}
                        onChange={(event) =>
                          setSelectedChats(
                            event.target.checked
                              ? [...selectedChats, chat.id]
                              : selectedChats.filter((id) => id !== chat.id),
                          )
                        }
                      />
                      <span>{chat.title}</span>
                    </label>
                  ))
              )}
            </fieldset>
          ) : null}
          <details>
            <summary>Категории · {categories.length}</summary>
            <div className="karavan-module__choices">
              {karavanMarketplaceCategories.map(([id, label]) => (
                <label key={id}>
                  <input
                    type="checkbox"
                    checked={categories.includes(id)}
                    onChange={(event) =>
                      setCategories(
                        event.target.checked
                          ? [...categories, id]
                          : categories.filter((item) => item !== id),
                      )
                    }
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </details>
          <details>
            <summary>Правила размещения</summary>
            <label className="karavan-module__field">
              <span>Правила для продавцов</span>
              <textarea
                value={rules}
                maxLength={12000}
                rows={5}
                onChange={(event) => setRules(event.target.value)}
              />
            </label>
          </details>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={!categories.length || !rules.trim()}
            onClick={start}
          >
            Создать и подключить
            {selectedChats.length > 1
              ? ` · ${selectedChats.length} ${countLabel(selectedChats.length, 'чат', 'чата', 'чатов')}`
              : ''}
          </button>
          <button type="button" onClick={() => setStep('name')}>
            Изменить название
          </button>
        </>
      )}
    </section>
  );
}
