import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import { isPrivateDirectChatId } from './chat-id.util';

export function resolveChatCatalogKind(params: {
  chatId: string;
  entityType?: ChatEntityType | null;
  managedHint?: boolean;
  contextOnlyHint?: boolean;
}): ChatCatalogKind {
  if (params.entityType === ChatEntityType.CHANNEL) {
    return ChatCatalogKind.MANAGED;
  }

  if (isPrivateDirectChatId(params.chatId)) {
    return ChatCatalogKind.PRIVATE_DIRECT;
  }

  if (params.managedHint) {
    return ChatCatalogKind.MANAGED;
  }

  if (params.contextOnlyHint) {
    return ChatCatalogKind.CONTEXT_ONLY;
  }

  return ChatCatalogKind.UNKNOWN;
}
