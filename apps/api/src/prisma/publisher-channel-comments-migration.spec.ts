import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260901090000_add_publisher_channel_comments/migration.sql',
  ),
  'utf8',
);
const compact = migration.replace(/\s+/gu, ' ').trim();

describe('Publisher channel comments migration policy', () => {
  it('copies Major comments only into exact active Publisher-owned channels', () => {
    expect(compact).toContain(
      'ADD COLUMN "channel_comments_enabled" BOOLEAN NOT NULL DEFAULT false',
    );
    expect(compact).toContain('major_settings."comments_enabled" = true');
    expect(compact).toContain('binding."status" = \'ACTIVE\'::"ChatBotMembershipStatus"');
    expect(compact).toContain('catalog."bot_id" = binding."publisher_bot_id"');
    expect(compact).toContain('catalog."entity_type" = chat."entity_type"');
    expect(compact).toContain('catalog."status" = \'ACTIVE\'');
    expect(compact).toContain('chat."entity_type" = \'CHANNEL\'::"ChatEntityType"');
    expect(compact).toContain('(policy."chat_id" IS NULL OR policy."publik_enabled" = true)');
    expect(compact).toContain(
      'ON CONFLICT ("chat_id") DO UPDATE SET "channel_comments_enabled" = EXCLUDED."channel_comments_enabled"',
    );
    expect(compact).not.toContain('UPDATE "channel_settings" SET "comments_enabled"');
  });

  it('converts only the established explicit advertising signature into a button', () => {
    expect(compact).toContain(
      'ADD COLUMN "post_signature_presentation" "ChannelPostSignaturePresentation" NOT NULL DEFAULT \'SIGNATURE\'',
    );
    expect(compact).toContain('WHERE "post_signature_enabled" = true');
    expect(compact).toContain('BTRIM("post_signature_url") <> \'\'');
    expect(compact).toContain('CHAR_LENGTH(BTRIM("post_signature_text")) <= 32');
    expect(compact).toContain("'заказать рекламу'");
    expect(compact).toContain("'📞 заказать рекламу'");
    expect(compact).toContain("'📞заказать рекламу'");
    expect(compact).toContain('"post_signature_text" = \'📞 Заказать рекламу\'');
  });

  it('indexes only unclaimed pending Publisher suggestions for bounded retention', () => {
    expect(compact).toContain(
      'CREATE INDEX CONCURRENTLY "audit_logs_publisher_suggestion_pending_retention_idx"',
    );
    expect(compact).toContain('ON "audit_logs" ("created_at", "id")');
    expect(compact).toContain('WHERE "action" = \'PUBLISHER_CHANNEL_DIALOG_SUGGESTION\'');
    expect(compact).toContain("\"payload\"->>'type' = 'suggest'");
    expect(compact).toContain("\"payload\"->>'reviewStatus' = 'pending'");
    expect(compact).toContain('"payload"->>\'reviewClaimToken\' IS NULL');
  });
});
