import { Prisma } from '../prisma/prisma-client';

export type RetentionBindingRow = {
  eraserOwned: boolean;
};

// FLAG: Exact local ownership is diagnostic only; the retired guard always rejects execution.
export function retentionBindingQuery(intentId: string): Prisma.Sql {
  return Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM eraser_chat_bindings eraser WHERE eraser.chat_id = intent.chat_id
      ) AS "eraserOwned"
      FROM "moderation_delete_intents" intent
      WHERE intent."id" = ${intentId}
      LIMIT 1
    `;
}
