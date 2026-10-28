import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  karavanMarketplaceSetupSchema,
  type KaravanMarketplaceSetup,
  type KaravanMarketplaceOperation,
  type KaravanMarketplaceHandoffDestination,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanMarketplace,
  getKaravanMarketplaceOperation,
  setupKaravanMarketplace,
  openKaravanMarketplace,
  saveKaravanPublicationChoice,
  cancelKaravanMarketplaceSetup,
} from '../../lib/api/karavan-marketplace-client';
import {
  hydrateMirroredItem,
  saveMirroredItem,
  removeMirroredItem,
} from '../../lib/native-storage';
import { openMaxBotLinkAndClose } from '../../lib/max-bridge';
import { ApiRequestError } from '../../lib/api-request-error';
import { describeUserFacingError } from '../../lib/user-facing-error';
import KaravanMarketplaceWizard from './karavan-marketplace-wizard';
import { useKaravanMarketplaceBinding } from './use-karavan-marketplace-binding';
import { Spinner } from '../../components/ui/spinner';
import '../../styles/karavan-marketplace.css';

export default function KaravanMarketplacePanel({
  api,
  chatId,
}: {
  api: ApiTransport;
  chatId: string;
}) {
  const queryClient = useQueryClient();
  const currentChat = useRef<string | null>(chatId);
  useEffect(() => {
    currentChat.current = chatId;
    return () => {
      currentChat.current = null;
    };
  }, [chatId]);
  const queryKey = ['karavan-marketplace', chatId] as const;
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getKaravanMarketplace(api, chatId, signal),
    staleTime: 15_000,
    retry: false,
  });
  const [step, setStep] = useState<'intro' | 'wizard' | 'existing'>('intro');
  const [saved, setSaved] = useState<KaravanMarketplaceSetup | null>(null);
  const [operation, setOperation] = useState<KaravanMarketplaceOperation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const module = query.data?.enabled ? query.data : null;
  const storageKey = module ? `karavan-setup:v1:${module.actorMaxUserId}:${chatId}` : null;
  const bind = useKaravanMarketplaceBinding(api, chatId, module?.actorMaxUserId);
  const [disconnectConfirm, setDisconnectConfirm] = useState(false);
  const chats = useQuery({
    queryKey: ['karavan-setup-chats'],
    enabled: !!saved,
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
          if (restored.state === 'complete' || restored.state === 'cancelled') {
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
            if (state.state === 'complete' || state.state === 'cancelled') {
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
      if (
        state.state === 'partial' &&
        state.checkpoints.bindings.some(
          (binding) => binding.chatId === chatId && binding.state === 'connected',
        )
      )
        void queryClient.invalidateQueries({ queryKey });
      if (state.state === 'complete' || state.state === 'cancelled') {
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
  const handoff = useMutation({
    mutationFn: async (destination: KaravanMarketplaceHandoffDestination) => ({
      ...(await openKaravanMarketplace(api, chatId, module!.marketplace!.id, destination)),
      sourceChatId: chatId,
    }),
    onSuccess: (result) => {
      if (currentChat.current !== result.sourceChatId) return;
      if (!openMaxBotLinkAndClose(result.url)) setNotice('Откройте магазин из MAX.');
    },
    onError: (error) => {
      if (currentChat.current !== chatId) return;
      setNotice(describeUserFacingError(error, 'Не удалось открыть магазин. Повторите попытку.'));
    },
  });
  const cancelSetup = useMutation({
    mutationFn: () => cancelKaravanMarketplaceSetup(api, chatId, saved!.operationId),
    onSuccess: () => {
      if (storageKey) removeMirroredItem(storageKey);
      setSaved(null);
      setOperation(null);
      setStep('intro');
      setNotice('Подключение остановлено. Созданный магазин и уже подключённые чаты сохранены.');
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      setNotice(
        describeUserFacingError(error, 'Не удалось остановить подключение. Повторите проверку.'),
      ),
  });
  const publicationChoice = useMutation({
    mutationFn: (input: { choiceId: string; storeId: string }) =>
      saveKaravanPublicationChoice(api, chatId, input),
    onSuccess: () => {
      setNotice('Выбор сохранён. Повторите $ в чате, когда захотите опубликовать ссылку.');
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (error) =>
      setNotice(describeUserFacingError(error, 'Не удалось сохранить выбор. Повторите попытку.')),
  });
  function start(input?: KaravanMarketplaceSetup) {
    if (!storageKey) return;
    const request = input ?? saved;
    if (!request) return;
    saveMirroredItem(storageKey, JSON.stringify(request));
    setSaved(request);
    setNotice(null);
    setup.mutate(request);
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
  const canEnter = canOpen && module.binding?.state === 'verified';
  const emptyDraft =
    canManage &&
    marketplace?.status === 'draft' &&
    module.counts.listings === 0 &&
    module.counts.pendingApplications === 0;
  const primaryDestination =
    !canManage && canReview ? 'applications' : emptyDraft ? 'invite_sellers' : 'manage';
  const applicationsLabel =
    module.counts.pendingApplications > 0
      ? `Заявки · ${module.counts.pendingApplications}`
      : 'Заявки';
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
      {module.publicationChoices.map((choice) => (
        <div key={choice.id} className="karavan-module__actions">
          <p>Выберите витрину для публикации по $ в этом чате.</p>
          {choice.stores.map((store) => (
            <button
              type="button"
              key={store.id}
              disabled={publicationChoice.isPending}
              onClick={() => publicationChoice.mutate({ choiceId: choice.id, storeId: store.id })}
            >
              {store.name}
            </button>
          ))}
          <p>
            Другую свою витрину можно выбрать в её кабинете Каравана. Сохранение ничего не
            отправляет в чат.
          </p>
        </div>
      ))}
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
              onClick={() => start()}
            >
              {setup.isPending ? 'Подключаем…' : 'Продолжить подключение'}
            </button>
          ) : null}
          {operation?.state === 'rejected' && !operation.checkpoints.marketplaceId && saved ? (
            <button
              type="button"
              onClick={() => {
                if (storageKey) removeMirroredItem(storageKey);
                setSaved(null);
                setOperation(null);
                setNotice(null);
                setStep('wizard');
              }}
            >
              Изменить настройки
            </button>
          ) : null}
          {operation?.state === 'partial' &&
          !operation.checkpoints.bindings.some((item) => item.state === 'unknown') ? (
            <button
              type="button"
              disabled={setup.isPending || cancelSetup.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    'Остановить оставшиеся подключения? Созданный магазин и уже подключённые чаты сохранятся.',
                  )
                )
                  cancelSetup.mutate();
              }}
            >
              Остановить оставшиеся подключения
            </button>
          ) : null}
          {canEnter && operation?.checkpoints.marketplaceId === marketplace?.id ? (
            <button type="button" disabled={busy} onClick={() => handoff.mutate('manage')}>
              {handoff.isPending ? 'Открываем…' : 'Настроить черновик'}
            </button>
          ) : null}
        </>
      ) : marketplace && step === 'intro' ? (
        <>
          <div className="karavan-module__identity">
            <h3>{marketplace.name}</h3>
            <p>
              {active
                ? 'Открыт'
                : marketplace.status === 'draft'
                  ? 'Черновик'
                  : marketplace.status === 'paused'
                    ? 'На паузе'
                    : 'В архиве'}
            </p>
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
          <div className="karavan-module__entry-actions">
            {canEnter ? (
              <button
                type="button"
                className="karavan-module__primary"
                disabled={busy}
                onClick={() => handoff.mutate(primaryDestination)}
              >
                {handoff.isPending
                  ? 'Открываем…'
                  : primaryDestination === 'applications'
                    ? applicationsLabel
                    : emptyDraft
                      ? 'Пригласить продавцов'
                      : 'Управлять'}
              </button>
            ) : null}
            {active && module.buyerUrl ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (canEnter) handoff.mutate('view');
                  else if (!openMaxBotLinkAndClose(module.buyerUrl!))
                    setNotice('Откройте магазин из MAX.');
                }}
              >
                Посмотреть магазин
              </button>
            ) : (marketplace.status === 'draft' || marketplace.status === 'paused') &&
              module.previewUrl ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (canEnter) handoff.mutate('preview');
                  else if (!openMaxBotLinkAndClose(module.previewUrl!))
                    setNotice('Откройте магазин из MAX.');
                }}
              >
                Предпросмотр
              </button>
            ) : null}
          </div>
          {canEnter ? (
            <div className="karavan-module__actions karavan-module__tools">
              {primaryDestination !== 'applications' &&
              canReview &&
              module.counts.pendingApplications > 0 ? (
                <button
                  type="button"
                  disabled={handoff.isPending}
                  onClick={() => handoff.mutate('applications')}
                >
                  {applicationsLabel}
                </button>
              ) : null}
              {canManage && marketplace.status !== 'archived' ? (
                <button
                  type="button"
                  disabled={handoff.isPending}
                  onClick={() => handoff.mutate(emptyDraft ? 'manage' : 'invite_sellers')}
                >
                  {emptyDraft ? 'Управлять' : 'Пригласить продавцов'}
                </button>
              ) : null}
              {canManage && marketplace.status === 'draft' ? (
                <button
                  type="button"
                  disabled={handoff.isPending}
                  onClick={() => handoff.mutate('open_marketplace')}
                >
                  Открыть для покупателей
                </button>
              ) : null}
            </div>
          ) : !canOpen ? (
            <p>Попросите владельца магазина предоставить доступ к управлению.</p>
          ) : null}
          {module.bindings?.length ? (
            <details>
              <summary>Подключённые чаты · {module.counts.chats}</summary>
              <ul className="karavan-module__progress">
                {module.bindings.map((binding) => (
                  <li key={binding.id}>
                    <span>{binding.chatTitle || 'Чат'}</span>
                    <strong>
                      {binding.state === 'verified'
                        ? 'Подключён'
                        : binding.state === 'disconnected'
                          ? 'Отключён'
                          : 'Нужна проверка'}
                    </strong>
                  </li>
                ))}
              </ul>
              {module.counts.chats > module.bindings.length ? (
                <p>Все подключения доступны в настройках магазина.</p>
              ) : null}
            </details>
          ) : null}
          {canBind ? (
            <details>
              <summary>Настройки подключения</summary>
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
          <h3>{module.currentChatTitle || 'Магазин вашего чата'}</h3>
          <button
            type="button"
            className="karavan-module__primary"
            disabled={!ready}
            onClick={() => setStep('wizard')}
          >
            Подключить магазин
          </button>
        </>
      ) : (
        <KaravanMarketplaceWizard
          api={api}
          chatId={chatId}
          chatTitle={module.currentChatTitle ?? ''}
          actorId={module.actorMaxUserId}
          existing={step === 'existing'}
          onCancel={() => setStep('intro')}
          onSubmit={start}
        />
      )}
    </section>
  );
}
