import { ApiRequestError } from '../../../lib/api-request-error';
import { createContext, useContext } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  manageKaravanShop,
  type ShopScope,
  type ShopCommand,
} from '../../../lib/api/karavan-shop-client';
import { describeUserFacingError } from '../../../lib/user-facing-error';
export const ShopContext = createContext<{ api: ApiTransport; scope: ShopScope } | null>(null);
export function useShop() {
  const value = useContext(ShopContext);
  if (!value) throw new Error('Missing shop');
  return value;
}
export function useShopQuery<K extends ShopCommand['operation']>(
  command: Extract<ShopCommand, { operation: K }>,
  enabled = true,
) {
  const { api, scope } = useShop();
  return useQuery({
    queryKey: ['karavan-shop', scope, command],
    enabled,
    queryFn: ({ signal }) => manageKaravanShop<K>(api, scope, command, signal),
    retry: false,
    staleTime: 10_000,
  });
}
export function useShopMutation(onSuccess?: (command: ShopCommand) => void) {
  const { api, scope } = useShop();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: ShopCommand) => manageKaravanShop(api, scope, command),
    onSuccess: async (_data, thisCommand) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['karavan-shop', scope] }),
        client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] }),
      ]);
      onSuccess?.(thisCommand);
    },
  });
}
export function ShopFailure({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="karavan-module__notice" role="alert">
      <p>{describeUserFacingError(error, 'Не удалось загрузить магазин.')}</p>
      <button type="button" onClick={retry}>
        Повторить
      </button>
    </div>
  );
}
export function MutationFailure({
  mutation,
  onRefresh,
}: {
  mutation: ReturnType<typeof useShopMutation>;
  onRefresh?: () => void;
}) {
  const { scope } = useShop();
  const client = useQueryClient();
  if (!mutation.isError) return null;
  const conflict =
    mutation.error instanceof ApiRequestError &&
    [400, 403, 404, 409, 422].includes(mutation.error.status);
  return (
    <div className="karavan-module__notice" role="alert">
      <p>{describeUserFacingError(mutation.error, 'Не удалось выполнить действие.')}</p>
      {conflict ? (
        <button
          type="button"
          onClick={() => {
            mutation.reset();
            onRefresh?.();
            void client.invalidateQueries({ queryKey: ['karavan-shop', scope] });
            void client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] });
          }}
        >
          Обновить данные
        </button>
      ) : (
        <button
          type="button"
          onClick={() => mutation.variables && mutation.mutate(mutation.variables)}
        >
          Повторить проверку
        </button>
      )}
    </div>
  );
}
export function ShopLoading() {
  return <p role="status">Загружаем…</p>;
}
