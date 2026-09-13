import { z } from 'zod';

export const publishChatRulesRequestSchema = z
  .object({
    mode: z.enum(['new_message', 'update']).optional(),
  })
  .strict();
export type PublishChatRulesRequest = z.infer<typeof publishChatRulesRequestSchema>;
