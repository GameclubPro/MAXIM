import { z } from 'zod';
import {
  marketplaceProfileStatisticsSchema,
  marketplaceStatisticRowSchema,
  marketplaceStatisticsManifestSchema,
} from '@maxim/contracts/marketplace-integration';

export function profileStatisticsSummary(
  consent: boolean,
  generation?: { manifest: unknown; rows: unknown },
) {
  const empty = { observedDays: 0, lastObservedAt: null, from: null, to: null };
  if (!consent) return marketplaceProfileStatisticsSchema.parse({ ...empty, state: 'DISABLED' });
  if (!generation) return marketplaceProfileStatisticsSchema.parse({ ...empty, state: 'PENDING' });
  const manifest = marketplaceStatisticsManifestSchema.parse(generation.manifest);
  const rows = z.array(marketplaceStatisticRowSchema).max(3000).parse(generation.rows);
  const observed = rows.filter(
    (row) =>
      row.metric === 'AUDIENCE' &&
      row.value !== null &&
      row.observedAt !== null &&
      row.bucket >= manifest.from &&
      row.bucket <= manifest.to,
  );
  const dates = new Set(observed.map((row) => row.bucket.slice(0, 10)));
  return marketplaceProfileStatisticsSchema.parse({
    state: dates.size ? 'AVAILABLE' : manifest.complete ? 'EMPTY' : 'PENDING',
    observedDays: dates.size,
    lastObservedAt: observed.reduce<string | null>(
      (latest, row) => (!latest || row.observedAt! > latest ? row.observedAt : latest),
      null,
    ),
    from: manifest.from,
    to: manifest.to,
  });
}
