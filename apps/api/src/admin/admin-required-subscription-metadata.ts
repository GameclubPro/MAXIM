import type { ManagedEntityHeader } from '@maxim/contracts';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  createManagedEntityHeader,
  sanitizePublicManagedEntityHeader,
} from './admin-managed-entity-header';

export async function readSavedRequiredSubscriptionHeaders(
  ids: readonly string[],
  prisma: PrismaService,
  cache: ChatContextCacheService,
): Promise<ManagedEntityHeader[]> {
  const headers = new Map<string, ManagedEntityHeader>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const header =
          (await cache.getManagedEntityHeader?.(id, 'channel')) ??
          (await cache.getManagedEntityHeader?.(id, 'chat'));
        if (header) headers.set(id, sanitizePublicManagedEntityHeader(header));
      } catch {
        /* A cache outage must not erase the saved selection. */
      }
    }),
  );
  const missing = ids.filter((id) => !headers.has(id));
  if (missing.length > 0) {
    // FLAG: These IDs come only from the authorized source's saved settings, never a fleet scan.
    const [catalog, chats] = await Promise.allSettled([
      prisma.managedBotChatCatalog.findMany({
        where: { chatId: { in: missing } },
        orderBy: [{ lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
        take: missing.length * 8,
        select: { chatId: true, title: true, entityType: true, link: true, avatarUrl: true },
      }),
      prisma.chat.findMany({
        where: { id: { in: missing } },
        select: { id: true, title: true, entityType: true },
      }),
    ]);
    for (const id of missing) {
      const row =
        catalog.status === 'fulfilled' ? catalog.value.find((row) => row.chatId === id) : undefined;
      const chat =
        chats.status === 'fulfilled' ? chats.value.find((row) => row.id === id) : undefined;
      const header = createManagedEntityHeader({
        id,
        title: row?.title?.trim() || chat?.title?.trim() || id,
        entityType: (row?.entityType ?? chat?.entityType) === 'CHAT' ? 'chat' : 'channel',
        link: row?.link,
        avatarUrl: row?.avatarUrl,
      });
      header.accessDiagnostics.state = 'stale';
      header.accessDiagnostics.source = row || chat ? 'cache' : 'unknown';
      headers.set(id, header);
    }
  }
  return ids.map((id) => headers.get(id)!);
}
