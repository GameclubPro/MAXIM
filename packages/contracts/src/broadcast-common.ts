import { z } from 'zod';

export const broadcastTextFormatSchema = z.enum(['plain', 'markdown']);
export type BroadcastTextFormat = z.infer<typeof broadcastTextFormatSchema>;
