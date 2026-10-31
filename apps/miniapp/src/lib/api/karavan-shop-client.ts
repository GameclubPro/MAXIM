import {
  marketplaceManagementResponseSchema,
  marketplaceManagementRequestSchema,
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
  const result = await dispatchShopRequest(api, prepareShopRequest(scope, command), signal);
  return result.data as ShopResponse<K>;
}
export function prepareShopRequest(
  scope: ShopScope,
  command: ShopCommand,
): MarketplaceManagementRequest {
  const commandId =
    'input' in command && 'commandId' in command.input
      ? command.input.commandId
      : crypto.randomUUID();
  return marketplaceManagementRequestSchema.parse({
    chatId: scope.chatId,
    marketplaceId: scope.marketplaceId,
    expectedBindingGeneration: scope.expectedBindingGeneration,
    commandId,
    command,
  });
}
export async function dispatchShopRequest(
  api: ApiTransport,
  input: MarketplaceManagementRequest,
  signal?: AbortSignal,
): Promise<MarketplaceManagementResponse> {
  const request = marketplaceManagementRequestSchema.parse(input);
  const result = marketplaceManagementResponseSchema.parse(
    await api.request(`/chats/${encodeURIComponent(request.chatId)}/karavan-marketplace/manage`, {
      method: 'POST',
      body: JSON.stringify(request),
      signal,
      timeoutMs: 45_000,
      retryMutationOnTransportError: false,
    }),
  );
  if (result.operation !== request.command.operation)
    throw new Error('Ответ магазина изменился. Обновите экран.');
  return result;
}
