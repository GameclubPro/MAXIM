import { z } from 'zod';
import { managedEntityFavoriteTypeSchema, managedEntityTypeSchema } from './managed-entities.js';
export const networkStatisticsRangeSchema = z.enum(['7d', '30d']);

export const networkStatisticsQuerySchema = z
  .object({
    favoriteType: managedEntityFavoriteTypeSchema,
    range: networkStatisticsRangeSchema.default('7d'),
    cursor: z.string().uuid().optional(),
  })
  .strict();
export type NetworkStatisticsQuery = z.infer<typeof networkStatisticsQuerySchema>;

export const networkMetricCoverageSchema = z.object({
  status: z.enum(['ready', 'partial', 'unavailable']),
  includedEntities: z.number().int().nonnegative(),
  totalEntities: z.number().int().nonnegative(),
  observedFrom: z.string().datetime().nullable(),
  asOf: z.string().datetime().nullable(),
});
export type NetworkMetricCoverage = z.infer<typeof networkMetricCoverageSchema>;

const metric = z.object({
  value: z.number().int().nullable(),
  coverage: networkMetricCoverageSchema,
});
export const networkStatisticsResponseSchema = z.object({
  entityType: managedEntityTypeSchema,
  favoriteType: managedEntityFavoriteTypeSchema,
  label: z.string(),
  compositionVersion: z.string(),
  period: z.object({
    range: networkStatisticsRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
    timezone: z.literal('Europe/Moscow'),
    bucket: z.literal('day'),
  }),
  authorization: z.object({
    checked: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    allowed: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    unavailable: z.number().int().nonnegative(),
  }),
  audience: metric,
  netGrowth: metric,
  viewsGained: metric.nullable(),
  series: z
    .array(
      z.object({
        at: z.string().datetime(),
        netGrowth: z.number().int().nullable(),
        viewsGained: z.number().int().nonnegative().nullable(),
        viewsComplete: z.boolean(),
      }),
    )
    .max(32),
  items: z.array(
    z.object({
      entityId: z.string(),
      title: z.string(),
      audience: z.number().int().nonnegative().nullable(),
      audienceObservedAt: z.string().datetime().nullable(),
      netGrowth: z.number().int().nullable(),
      viewsGained: z.number().int().nonnegative().nullable(),
      viewsCoverage: networkMetricCoverageSchema.nullable(),
    }),
  ),
  unallocatedViews: z.number().int().nonnegative(),
  nextCursor: z.string().uuid().nullable(),
  retryAfterMs: z.number().int().min(250).max(30_000),
  method: z.literal('current-composition-observed-intervals-v2'),
});
export type NetworkStatisticsResponse = z.infer<typeof networkStatisticsResponseSchema>;
