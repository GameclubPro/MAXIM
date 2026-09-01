import { z } from 'zod';

export const managedEntityTypeSchema = z.enum(['chat', 'channel']);
export type ManagedEntityType = z.infer<typeof managedEntityTypeSchema>;
