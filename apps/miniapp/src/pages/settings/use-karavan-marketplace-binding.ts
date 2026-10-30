import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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

export function useKaravanMarketplaceBinding(api: ApiTransport, chatId: string, actorId?: string) {
  const queryClient = useQueryClient();
  const storageKey = actorId ? `karavan-binding:v1:${actorId}:${chatId}` : null;
  const [request, setRequest] = useState<KaravanChatBindingInput | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rejected, setRejected] = useState(false);
  const hadUnknownOutcome = useRef(false);
  useEffect(() => {
    if (!storageKey) return;
    let active = true;
    setHydrated(false);
    setRequest(null);
    void hydrateMirroredItem(storageKey)
      .then((raw) => {
        if (!active) return;
        if (raw) {
          try {
            setRequest(karavanChatBindingInputSchema.parse(JSON.parse(raw)));
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
      setRequest(null);
      setError(null);
      setRejected(false);
      void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
    },
    onError: (cause) => {
      if (
        cause instanceof ApiRequestError &&
        cause.status === 409 &&
        cause.code === 'MARKETPLACE_BINDING_CHANGED' &&
        !hadUnknownOutcome.current
      ) {
        // FLAG: Only a definitively rejected fresh request can be discarded. Never
        // replay a mutation or discard an earlier unknown outcome to refresh the screen.
        if (storageKey) removeMirroredItem(storageKey);
        setRequest(null);
        setError(null);
        setRejected(false);
        void queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
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
