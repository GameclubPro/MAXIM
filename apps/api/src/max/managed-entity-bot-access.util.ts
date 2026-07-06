import { ChatBotMembershipStatus } from '../prisma/prisma-client';

export type ManagedEntityBotMembershipIdentityRow = {
  chatId?: string | null;
  botId?: string | null;
  status?: ChatBotMembershipStatus | string | null;
};

export function collectActiveManagedEntityBotMembershipIds(
  rows: readonly ManagedEntityBotMembershipIdentityRow[],
  options: { isRuntimeBotId?: (botId: string) => boolean } = {},
): Set<string> {
  const botIds = new Set<string>();
  for (const row of rows) {
    const botId = normalizeManagedEntityAccessIdentity(row.botId);
    if (!botId || row.status !== ChatBotMembershipStatus.ACTIVE) {
      continue;
    }
    if (options.isRuntimeBotId && !options.isRuntimeBotId(botId)) {
      continue;
    }
    botIds.add(botId);
  }
  return botIds;
}

export function collectActiveManagedEntityBotMembershipIdsByChat(
  rows: readonly ManagedEntityBotMembershipIdentityRow[],
  options: { isRuntimeBotId?: (botId: string) => boolean } = {},
): Map<string, Set<string>> {
  const botIdsByChatId = new Map<string, Set<string>>();
  for (const row of rows) {
    const chatId = normalizeManagedEntityAccessIdentity(row.chatId);
    const botId = normalizeManagedEntityAccessIdentity(row.botId);
    if (!chatId || !botId || row.status !== ChatBotMembershipStatus.ACTIVE) {
      continue;
    }
    if (options.isRuntimeBotId && !options.isRuntimeBotId(botId)) {
      continue;
    }
    const botIds = botIdsByChatId.get(chatId) ?? new Set<string>();
    botIds.add(botId);
    botIdsByChatId.set(chatId, botIds);
  }
  return botIdsByChatId;
}

function normalizeManagedEntityAccessIdentity(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
