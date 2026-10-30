import type { previewKaravanMarketplace } from '../../lib/api/karavan-marketplace-client';

type SetupReview = Awaited<ReturnType<typeof previewKaravanMarketplace>>;

export function changedMarketplaceSetupReview(
  reviewed: SetupReview,
  latest: SetupReview,
): 'rules' | 'connections' | null {
  if (
    reviewed.target?.marketplace.id === latest.target?.marketplace.id &&
    reviewed.target?.marketplace.policyRevision !== latest.target?.marketplace.policyRevision
  )
    return 'rules';
  const connections = (value: SetupReview) =>
    JSON.stringify({
      target: value.target?.marketplace.id,
      chats: value.chats.map((chat) => ({
        chatId: chat.chatId,
        bindingId: chat.binding?.id,
        generation: chat.binding?.generation,
        state: chat.binding?.state,
        marketplaceId: chat.marketplace?.id,
      })),
    });
  return connections(reviewed) === connections(latest) ? null : 'connections';
}
