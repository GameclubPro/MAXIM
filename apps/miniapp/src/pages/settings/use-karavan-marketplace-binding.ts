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
import {
  hydrateMirroredItem,
  removeMirroredItem,
  saveMirroredItem,
} from '../../lib/native-storage';
import { describeUserFacingError } from '../../lib/user-facing-error';

export function useKaravanMarketplaceBinding(
  api: ApiTransport,
  chatId: string,
  actorId?: string,
  freshBinding?: KaravanMarketplaceModule['binding'],
) {
  const queryClient = useQueryClient();
  const storageKey = actorId ? `karavan-binding:v1:${actorId}:${chatId}` : null;
  const [request, setRequest] = useState<KaravanChatBindingInput | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const hadUnknownOutcome = useRef(false);
  const requestStorageKey = useRef<string | null>(null);
  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    requestStorageKey.current = null;
    setHydrated(false);
    setRequest(null);
    void hydrateMirroredItem(storageKey)
      .then((raw) => {
        if (!active) return;
        if (raw) {
          try {
            const restored = karavanChatBindingInputSchema.parse(JSON.parse(raw));
            requestStorageKey.current = storageKey;
            setRequest(restored);
            hadUnknownOutcome.current = true;
          } catch {
            setError('Не удалось восстановить запрос подключения. Обратитесь в поддержку.');
            return;
          }
        }
        setHydrated(true);
      })
      .catch(() => {
        if (active)
          setError('Не удалось прочитать сохранённое подключение. Откройте настройки повторно.');
      });
    return () => {
      active = false;
    };
  }, [storageKey]);
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
    request,
    hydrated,
    error,
    rejected,
    isPending: mutation.isPending,
    start(input: Omit<KaravanChatBindingInput, 'commandId'>) {
      if (!storageKey || !hydrated || request || mutation.isPending) return;
      const next = karavanChatBindingInputSchema.parse({
        ...input,
        commandId: crypto.randomUUID(),
      });
      saveMirroredItem(storageKey, JSON.stringify(next));
      requestStorageKey.current = storageKey;
      setRequest(next);
      setError(null);
      setRejected(false);
      hadUnknownOutcome.current = false;
      mutation.mutate(next);
    },
    retry() {
      if (request && !mutation.isPending) mutation.mutate(request);
    },
    resetRejected() {
      if (!rejected || mutation.isPending) return;
      if (storageKey) removeMirroredItem(storageKey);
      setRequest(null);
      setError(null);
      setRejected(false);
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
    },
  };
}
