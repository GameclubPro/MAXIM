import { z } from 'zod';
import { exchangeManifestSchema, exchangeMeasurementSchema } from './statistics-exchange.js';
import { marketplaceBindingInputSchema } from './marketplace-integration.js';

// Latest source manifests describe uploaded generations. Selected rows retain per-row provenance;
// the combined owner read model is never itself an export generation or checksum claim.
export const exchangeSelectedStatisticsSchema = z
  .object({
    grantId: z.string().uuid(),
    grantRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    entityId: marketplaceBindingInputSchema.shape.entityId,
    kind: marketplaceBindingInputSchema.shape.kind,
    sources: z.array(exchangeManifestSchema).max(2),
    rows: z.array(exchangeMeasurementSchema).max(3000),
    sync: z
      .object({ lastSuccessfulPullAt: z.string().datetime().nullable(), error: z.boolean() })
      .strict(),
  })
  .strict();
export type ExchangeSelectedStatistics = z.infer<typeof exchangeSelectedStatisticsSchema>;
