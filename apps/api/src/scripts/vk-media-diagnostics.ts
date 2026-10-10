import { Prisma, type PrismaClient } from '../prisma/prisma-client';

const MEDIA_SAMPLE_CAP = 1_000;
type MediaRow = {
  id: string;
  url: string;
  mediaIdentity: string | null;
  status: string;
  lastCheckedAt: Date | null;
  updatedAt: Date;
  lastError: string | null;
  failure: boolean;
};

export function buildVkMediaDiagnosticQuery() {
  // FLAG: Bound the indexed source before error matching, grouping and conflict work.
  // The sentinel proves truncation; this sample cannot establish global absence of failures.
  return Prisma.sql`
    with bounded as materialized (
      select id, url, media_identity, status, last_checked_at, updated_at, last_error
      from vk_parsing_media_cache
      order by id desc
      limit ${MEDIA_SAMPLE_CAP + 1}
    )
    select id, url, media_identity as "mediaIdentity", status,
      last_checked_at as "lastCheckedAt", updated_at as "updatedAt",
      left(last_error, 300) as "lastError",
      (status = 'FAILED' or last_error ilike '%unique constraint%' or last_error ilike '%P2002%')
        is true as failure
    from bounded order by id desc
  `;
}

export async function loadMediaDiagnostics(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  since: Date,
  limit: number,
) {
  const candidates = await prisma.$queryRaw<MediaRow[]>(buildVkMediaDiagnosticQuery());
  const rows = candidates.slice(0, MEDIA_SAMPLE_CAP);
  const statuses = new Map<
    string,
    { status: string; count: number; latestCheckedAt: Date | null; withIdentity: number }
  >();
  const identities = new Map<string, MediaRow[]>();
  for (const row of rows) {
    const state = statuses.get(row.status) ?? {
      status: row.status,
      count: 0,
      latestCheckedAt: null,
      withIdentity: 0,
    };
    state.count++;
    if (row.lastCheckedAt && (!state.latestCheckedAt || row.lastCheckedAt > state.latestCheckedAt))
      state.latestCheckedAt = row.lastCheckedAt;
    if (row.mediaIdentity !== null) {
      state.withIdentity++;
      const matching = identities.get(row.mediaIdentity) ?? [];
      matching.push(row);
      identities.set(row.mediaIdentity, matching);
    }
    statuses.set(row.status, state);
  }
  return {
    mediaCoverage: {
      sampleBasis: 'id_desc' as const,
      sampleCap: MEDIA_SAMPLE_CAP,
      scannedRows: rows.length,
      sourceTruncated: candidates.length > MEDIA_SAMPLE_CAP,
      complete: candidates.length <= MEDIA_SAMPLE_CAP,
    },
    mediaStatus: [...statuses.values()].sort(
      (a, b) => b.count - a.count || a.status.localeCompare(b.status),
    ),
    mediaIdentityConflicts: [...identities.entries()]
      .filter(([, matches]) => matches.length > 1)
      .map(([mediaIdentity, matches]) => {
        matches.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return {
          mediaIdentity,
          rowCount: matches.length,
          urls: matches.map((row) => row.url),
          latestAt: matches[0]!.updatedAt,
        };
      })
      .sort((a, b) => b.rowCount - a.rowCount || b.latestAt.getTime() - a.latestAt.getTime())
      .slice(0, limit),
    recentMediaFailures: rows
      .filter((row) => row.failure && (row.lastCheckedAt ?? row.updatedAt) >= since)
      .sort(
        (a, b) =>
          (b.lastCheckedAt ?? b.updatedAt).getTime() - (a.lastCheckedAt ?? a.updatedAt).getTime() ||
          b.id.localeCompare(a.id),
      )
      .slice(0, limit)
      .map(({ id, url, mediaIdentity, status, lastCheckedAt, lastError }) => ({
        id,
        url,
        mediaIdentity,
        status,
        lastCheckedAt,
        lastError,
      })),
  };
}
