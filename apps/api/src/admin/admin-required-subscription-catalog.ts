import type { MaxBotChat } from '../max/max-client.service';
import type {
  ManagedBotChatCatalogSnapshotRow,
  ManagedEntitiesDiscoverySnapshot,
} from './admin.service.support';

type RequiredSubscriptionCatalogDelegate = {
  findMany(args: unknown): Promise<unknown>;
};

export async function resolveRequiredSubscriptionChannelByKnownLink(params: {
  normalizedLink: string;
  catalog: RequiredSubscriptionCatalogDelegate | null | undefined;
  normalizeLink: (value: string | null | undefined) => string | null;
  mergeCatalogRows: (
    rows: readonly ManagedBotChatCatalogSnapshotRow[],
  ) => ManagedEntitiesDiscoverySnapshot;
}): Promise<MaxBotChat | null> {
  const linkCandidates = buildRequiredSubscriptionChannelLinkLookupCandidates(
    params.normalizedLink,
  );
  if (linkCandidates.length === 0 || !params.catalog) {
    return null;
  }

  const rows = (await params.catalog.findMany({
    where: {
      link: { in: linkCandidates },
    },
    orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }, { updatedAt: 'desc' }],
    take: 20,
    select: {
      botId: true,
      chatId: true,
      entityType: true,
      title: true,
      link: true,
      avatarUrl: true,
      lastEventTime: true,
      lastSeenAt: true,
    },
  })) as ManagedBotChatCatalogSnapshotRow[];
  const matchedRows = rows.filter(
    (row) => params.normalizeLink(row.link) === params.normalizedLink,
  );
  const [matched] = params.mergeCatalogRows(matchedRows);
  return matched ?? null;
}

export function buildRequiredSubscriptionChannelLinkLookupCandidates(
  normalizedLink: string,
): string[] {
  const candidates = new Set<string>([normalizedLink]);

  try {
    const parsed = new URL(normalizedLink);
    const hostname = parsed.hostname.trim().toLowerCase();
    if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
      return [...candidates];
    }

    const pathSegments = parsed.pathname
      .split('/')
      .map((segment) => segment.trim())
      .filter(Boolean);
    const rootSegment = pathSegments[0]?.toLowerCase();
    if (
      pathSegments.length === 1 &&
      rootSegment !== 'chat' &&
      rootSegment !== 'chats' &&
      rootSegment !== 'c' &&
      rootSegment !== 'join'
    ) {
      candidates.add(`https://max.ru/channel/${pathSegments[0]}`);
      candidates.add(`https://max.ru/channels/${pathSegments[0]}`);
    }
  } catch {
    // Keep the normalized link as the only lookup candidate.
  }

  for (const candidate of [...candidates]) {
    candidates.add(`${candidate}/`);
  }

  return [...candidates];
}
