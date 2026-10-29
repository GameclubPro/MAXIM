import {
  marketplaceManagementResponseSchema,
  type MarketplaceManagementOperation,
  type MarketplaceManagementRequest,
  type MarketplaceManagementResponse,
} from '@maxim/contracts/karavan-marketplace-management';
import type { ApiTransport } from './transport';
export type ShopScope = {
  chatId: string;
  marketplaceId: string;
  expectedBindingGeneration: number;
};
export type ShopCommand = MarketplaceManagementOperation;
export type ShopResponse<K extends ShopCommand['operation']> = Extract<
  MarketplaceManagementResponse,
  { operation: K }
>['data'];
export async function manageKaravanShop<K extends ShopCommand['operation']>(
  api: ApiTransport,
  scope: ShopScope,
  command: Extract<ShopCommand, { operation: K }>,
  signal?: AbortSignal,
): Promise<ShopResponse<K>> {
  const commandId =
    'input' in command && 'commandId' in command.input
      ? command.input.commandId
      : crypto.randomUUID();
  const request: MarketplaceManagementRequest = { ...scope, commandId, command };
  const result = marketplaceManagementResponseSchema.parse(
    await api.request(`/chats/${encodeURIComponent(scope.chatId)}/karavan-marketplace/manage`, {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
      timeoutMs: 45_000,
      retryMutationOnTransportError: false,
    }),
  );
  if (result.operation !== command.operation)
    throw new Error('Ответ магазина изменился. Обновите экран.');
  return result.data as ShopResponse<K>;
}
