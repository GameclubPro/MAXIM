import { z } from 'zod';
import {
  karavanMarketplaceAvailableSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceModuleSchema,
  karavanMarketplaceOperationSchema,
  type KaravanMarketplaceSetup,
  type KaravanMarketplaceHandoffDestination,
} from '@maxim/contracts/karavan-marketplace';
import type { ApiTransport } from './transport';
const moduleSchema = z.union([
  z.object({ enabled: z.literal(false) }),
  karavanMarketplaceModuleSchema.extend({
    enabled: z.literal(true),
    actorMaxUserId: z.string(),
    sellerBotUrl: z.string().url(),
    setupOperation: karavanMarketplaceOperationSchema.nullable(),
  }),
]);
const path = (chatId: string) => `/chats/${encodeURIComponent(chatId)}/karavan-marketplace`;
export async function getKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  signal?: AbortSignal,
) {
  return moduleSchema.parse(await api.request(path(chatId), { signal }));
}
export async function setupKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  input: KaravanMarketplaceSetup,
) {
  return karavanMarketplaceOperationSchema.parse(
    await api.request(`${path(chatId)}/setup`, {
      method: 'POST',
      body: JSON.stringify(input),
      timeoutMs: 180_000,
      retryMutationOnTransportError: false,
    }),
  );
}
export async function getKaravanMarketplaceOperation(
  api: ApiTransport,
  chatId: string,
  operationId: string,
) {
  return karavanMarketplaceOperationSchema.parse(
    await api.request(`${path(chatId)}/operations/${encodeURIComponent(operationId)}`),
  );
}
export async function openKaravanMarketplace(
  api: ApiTransport,
  chatId: string,
  marketplaceId: string,
  destination: KaravanMarketplaceHandoffDestination,
) {
  return z.object({ url: z.string().url(), expiresAt: z.string().datetime() }).parse(
    await api.request(`${path(chatId)}/handoffs`, {
      method: 'POST',
      body: JSON.stringify({ commandId: crypto.randomUUID(), marketplaceId, destination }),
      retryMutationOnTransportError: false,
    }),
  );
}

export async function getAvailableKaravanMarketplaces(
  api: ApiTransport,
  chatId: string,
  cursor: string | null,
) {
  return karavanMarketplaceAvailableSchema.parse(
    await api.request(
      `${path(chatId)}/available${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  );
}
export const karavanChatBindingInputSchema = z
  .object({
    marketplaceId: z.string().uuid(),
    commandId: z.string().uuid(),
    expectedBindingGeneration: z.number().int().positive().nullable(),
    action: z.enum(['bind_chat', 'unbind_chat', 'recover_chat', 'transfer_chat']),
  })
  .strict();
export type KaravanChatBindingInput = z.infer<typeof karavanChatBindingInputSchema>;
export async function changeKaravanChatBinding(
  api: ApiTransport,
  chatId: string,
  input: KaravanChatBindingInput,
) {
  const { marketplaceId, ...payload } = karavanChatBindingInputSchema.parse(input);
  return karavanMarketplaceBindingResultSchema.parse(
    await api.request(`${path(chatId)}/bindings/${encodeURIComponent(marketplaceId)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
      retryMutationOnTransportError: false,
    }),
  );
}
