import { z } from 'zod';

export const managedEntityFavoriteTypeSchema = z.enum([
  'important',
  'watch',
  'broadcast',
  'test',
  'partner',
  'service',
]);
export type ManagedEntityFavoriteType = z.infer<typeof managedEntityFavoriteTypeSchema>;
