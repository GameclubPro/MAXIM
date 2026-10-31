import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import {
  changeKaravanChatBinding,
  karavanChatBindingInputSchema,
  type KaravanChatBindingInput,
} from '../../lib/api/karavan-marketplace-client';
import { ApiRequestError } from '../../lib/api-request-error';
import type { ApiTransport } from '../../lib/api/transport';
import { removeMirroredItem, saveMirroredItem } from '../../lib/native-storage';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  karavanBindingRecoveryMessage,
  readKaravanBindingRecovery,
  type KaravanBindingRecoveryState,
} from './karavan-binding-recovery';

export function useKaravanMarketplaceBinding(
  api: ApiTransport,
  chatId: string,
  actorId?: string,
  freshBinding?: KaravanMarketplaceModule['binding'],
) {
  const queryClient = useQueryClient();
  const storageKey = actorId ? `karavan-binding:v1:${actorId}:${chatId}` : null;
  const [request, setRequest] = useState<KaravanChatBindingInput | null>(null);
  const [recovery, setRecovery] = useState<{
    key: string | null;
    state: KaravanBindingRecoveryState;
  }>({ key: null, state: { status: 'loading' } });
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const hydrationState: KaravanBindingRecoveryState =
    recovery.key === storageKey ? recovery.state : { status: 'loading' };
  const hydrated = hydrationState.status === 'ready';
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const liveStorageKey = useRef(storageKey);
  liveStorageKey.current = storageKey;
  const hadUnknownOutcome = useRef(false);
  const requestStorageKey = useRef<string | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    requestStorageKey.current = null;
    setRecovery({ key: storageKey, state: { status: 'loading' } });
    setRequest(null);
    setError(null);
    setRejected(false);
    hadUnknownOutcome.current = false;
    startingRef.current = false;
    setStarting(false);
    void readKaravanBindingRecovery(storageKey)
      .then((state) => {
        if (!active) return;
        if (state.status === 'ready' && state.request) {
          requestStorageKey.current = storageKey;
          setRequest(state.request);
          hadUnknownOutcome.current = true;
        }
        setRecovery({ key: storageKey, state });
      })
      .catch(() => {
        if (active)
          setRecovery({ key: storageKey, state: { status: 'error', reason: 'unavailable' } });
      });
    return () => {
      active = false;
    };
  }, [storageKey, recoveryAttempt]);
  const mutation = useMutation({
    mutationFn: (input: KaravanChatBindingInput) => changeKaravanChatBinding(api, chatId, input),
    onSuccess: () => {
      if (storageKey) removeMirroredItem(storageKey);
      if (requestStorageKey.current !== storageKey) return;
      setRequest(null);
      setError(null);
      setRejected(false);
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
    },
    onError: (cause) => {
      if (requestStorageKey.current !== storageKey) return;
      const bindingChanged =
        cause instanceof ApiRequestError &&
        cause.status === 409 &&
        cause.code === 'MARKETPLACE_BINDING_CHANGED';
      if (bindingChanged)
        void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
      if (bindingChanged && !hadUnknownOutcome.current) {
        // FLAG: Only a definitively rejected fresh request can be discarded. Never
        // replay a mutation; an earlier unknown outcome needs the independent fence below.
        if (storageKey) removeMirroredItem(storageKey);
        setRequest(null);
        setError(null);
        setRejected(false);
        return;
      }
      const definitive =
        cause instanceof ApiRequestError &&
        (cause.code === 'KARAVAN_COMMAND_REJECTED' ||
          (cause.status >= 400 && cause.status < 500 && cause.status !== 408));
      setRejected(definitive && !hadUnknownOutcome.current);
      if (!definitive) hadUnknownOutcome.current = true;
      setError(
        describeUserFacingError(
          cause,
          definitive
            ? 'Подключение отклонено. Обновите состояние магазина.'
            : 'Результат пока не подтверждён. Повторите проверку подключения.',
        ),
      );
    },
  });
  useEffect(() => {
    if (
      !request ||
      requestStorageKey.current !== storageKey ||
      mutation.isPending ||
      freshBinding?.chatId !== chatId ||
      freshBinding.generation <= (request.expectedBindingGeneration ?? 0)
    )
      return;
    // FLAG: In this same actor/chat storage scope, a fresh, strictly newer chat
    // generation permanently fences the old write.
    // Show current state, not an invented command outcome. Equal/missing generations
    // retain uncertainty; never replay, reconnect or reopen a shop during reconciliation.
    if (storageKey) removeMirroredItem(storageKey);
    setRequest(null);
    setError(null);
    setRejected(false);
    hadUnknownOutcome.current = false;
  }, [
    request,
    mutation.isPending,
    chatId,
    storageKey,
    freshBinding?.chatId,
    freshBinding?.generation,
  ]);
  return {
    request: requestStorageKey.current === storageKey ? request : null,
    hydrated,
    hydrationState,
    recoveryError:
      hydrationState.status === 'error'
        ? karavanBindingRecoveryMessage(hydrationState.reason)
        : null,
    error,
    rejected,
    isPending: mutation.isPending || starting,
    start(input: Omit<KaravanChatBindingInput, 'commandId'>) {
      if (
        !storageKey ||
        !actorId ||
        !hydrated ||
        request ||
        mutation.isPending ||
        startingRef.current
      )
        return;
      const next = karavanChatBindingInputSchema.parse({
        ...input,
        commandId: crypto.randomUUID(),
      });
      const originalKey = storageKey;
      startingRef.current = true;
      setStarting(true);
      void (async () => {
        try {
          const { assertShopEntryWriteAvailable } = await import('./karavan-shop/command-journal');
          await assertShopEntryWriteAvailable(actorId, chatId, input.marketplaceId);
          if (liveStorageKey.current !== originalKey || requestStorageKey.current) return;
          saveMirroredItem(originalKey, JSON.stringify(next));
          requestStorageKey.current = originalKey;
          setRequest(next);
          setError(null);
          setRejected(false);
          hadUnknownOutcome.current = false;
          mutation.mutate(next);
        } catch (cause) {
          if (liveStorageKey.current === originalKey)
            setError(
              describeUserFacingError(
                cause,
                'Не удалось проверить сохранённое действие. Повторите.',
              ),
            );
        } finally {
          if (liveStorageKey.current === originalKey) {
            startingRef.current = false;
            setStarting(false);
          }
        }
      })();
    },
    retry() {
      if (hydrated && requestStorageKey.current === storageKey && request && !mutation.isPending)
        mutation.mutate(request);
    },
    retryRecovery() {
      if (hydrationState.status !== 'error' || mutation.isPending) return;
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
      setRecoveryAttempt((attempt) => attempt + 1);
    },
    resetRejected() {
      if (!hydrated || requestStorageKey.current !== storageKey || !rejected || mutation.isPending)
        return;
      if (storageKey) removeMirroredItem(storageKey);
      setRequest(null);
      setError(null);
      setRejected(false);
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
    },
  };
}
