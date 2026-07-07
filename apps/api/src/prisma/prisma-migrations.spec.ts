import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCAL_DISPLAY_NAME_EVENTS = [
  'message_created',
  'message_edited',
  'message_callback',
  'bot_started',
  'bot_added',
  'user_added',
  'user_removed',
] as const;

function readMigration(name: string): string {
  return readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
}

describe('Prisma migrations', () => {
  it('keeps the local display-name webhook lookup index aligned with the runtime SQL', () => {
    const migration = readMigration('20260707152000_optimize_local_display_name_lookup');
    const compact = migration.replace(/\s+/g, ' ').trim();

    expect(compact).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_local_display_name_chat_user_created_idx"',
    );
    expect(compact).toContain(
      `ON "webhook_events" ( (NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '')), (NULLIF(BTRIM("normalized_payload"->'message'->>'senderId'), '')), "created_at" DESC )`,
    );
    expect(compact).toContain(
      `NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), '') IS NOT NULL`,
    );
    expect(compact).toContain(
      `NULLIF(BTRIM("normalized_payload"->'message'->>'senderName'), '') IS NOT NULL`,
    );

    for (const eventType of LOCAL_DISPLAY_NAME_EVENTS) {
      expect(compact).toContain(`'${eventType}'`);
    }
  });
});
