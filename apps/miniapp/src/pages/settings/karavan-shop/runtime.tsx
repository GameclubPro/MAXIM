import { ApiRequestError } from '../../../lib/api-request-error';
import { createContext, useContext } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from '../../../lib/api/transport';
import {
  manageKaravanShop,
  type ShopScope,
  type ShopCommand,
  type ShopResponse,
} from '../../../lib/api/karavan-shop-client';
import { describeUserFacingError } from '../../../lib/user-facing-error';
export type ShopModule = KaravanMarketplaceModule & { sellerBotUrl?: string };
export const ShopContext = createContext<{
  api: ApiTransport;
  scope: ShopScope;
  module: ShopModule;
} | null>(null);
export function useShop() {
  const value = useContext(ShopContext);
  if (!value) throw new Error('Missing shop');
  return value;
}
export function useShopPages<K extends 'listings' | 'applications'>(
  command: Extract<ShopCommand, { operation: 'listings' | 'applications' }> & { operation: K },
) {
  const { api, scope } = useShop();
  return useInfiniteQuery({
    queryKey: ['karavan-shop', scope, 'pages', command],
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) =>
      manageKaravanShop<K>(
        api,
        scope,
        { ...command, input: { ...command.input, cursor: pageParam } } as Extract<
          ShopCommand,
          { operation: K }
        >,
        signal,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
    staleTime: 10_000,
  });
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
export function useShopMutation(
  onSuccess?: (command: ShopCommand, data: ShopResponse<ShopCommand['operation']>) => void,
) {
  const { api, scope } = useShop();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (command: ShopCommand) => manageKaravanShop(api, scope, command),
    onSuccess: async (data, thisCommand) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['karavan-shop', scope] }),
        client.invalidateQueries({ queryKey: ['karavan-marketplace', scope.chatId] }),
      ]);
      onSuccess?.(thisCommand, data);
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
