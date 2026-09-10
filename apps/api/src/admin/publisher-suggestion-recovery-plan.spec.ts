import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildPublisherSuggestionAdminRecoveryQuery,
  buildPublisherSuggestionAdminTerminalSyncRecoveryQuery,
} from './publisher-suggestion-admin-recovery.service';
import { buildPublisherSuggestionLegacyMigrationQuery } from './publisher-suggestion-publication-queue.service';

describe('Publisher suggestion recovery PostgreSQL plan', () => {
  it('uses the status/cursor index without scanning unrelated suggestion states', () => {
    const schema = `
        CREATE TYPE "ChannelSuggestionAdminDeliveryStatus" AS ENUM ('SENT', 'PENDING', 'FAILED', 'SENDING');
        CREATE TABLE audit_logs (
          id text PRIMARY KEY, action text NOT NULL, payload jsonb NOT NULL,
          created_at timestamp NOT NULL
        );
        CREATE TABLE channel_suggestion_admin_deliveries (
          audit_log_id text, bot_key text, status "ChannelSuggestionAdminDeliveryStatus",
          private_chat_id text, remote_message_id text,
          terminal boolean, locked_at timestamp, updated_at timestamp,
          last_error_code text, admin_user_id text
        );
        CREATE INDEX delivery_audit_bot_idx ON channel_suggestion_admin_deliveries(audit_log_id, bot_key);
        CREATE INDEX audit_logs_action_created_at_idx ON audit_logs(action, created_at DESC);
        INSERT INTO audit_logs
        SELECT 'pending-' || n, 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
          '{"type":"suggest","reviewStatus":"pending"}', '2026-09-01'::timestamp
        FROM generate_series(1, 20000) n;
        INSERT INTO audit_logs
        SELECT 'terminal-' || status, 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
          jsonb_build_object('type', 'suggest', 'reviewStatus', status), '2026-09-02'::timestamp
        FROM unnest(ARRAY['published', 'drafted', 'cancelled']) status;
        INSERT INTO channel_suggestion_admin_deliveries(audit_log_id, bot_key, status, private_chat_id, remote_message_id)
        SELECT id, 'publisher:test-bot', 'SENT', 'private-dialog', 'card'
        FROM audit_logs WHERE id LIKE 'terminal-%';
        CREATE TABLE webhook_events (bot_id text, created_at timestamp, normalized_payload jsonb);
        CREATE TABLE moderation_events (created_at timestamp);
        INSERT INTO webhook_events
        SELECT 'test-bot', '2026-09-01'::timestamp,
          jsonb_build_object('type', 'message_created', 'message', jsonb_build_object('senderId', n::text, 'chatId', '123'))
        FROM generate_series(1, 20000) n;
      `;
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260910110000_index_publisher_suggestion_recovery_status/migration.sql',
      ),
      'utf8',
    );
    expect(migration).toContain('CREATE INDEX CONCURRENTLY');
    const query = buildPublisherSuggestionAdminTerminalSyncRecoveryQuery({
      lookbackFrom: new Date('2026-09-01T00:00:00.000Z'),
      botKey: 'publisher:test-bot',
      publisherBotId: 'test-bot',
      cursor: { createdAt: new Date('2026-09-01T12:00:00.000Z'), id: 'cursor' },
    });
    const legacyQuery = buildPublisherSuggestionLegacyMigrationQuery(
      { createdAt: new Date('2026-09-01T12:00:00.000Z'), id: 'cursor' },
      new Date('2026-09-03T00:00:00.000Z'),
    );
    const adminQuery = buildPublisherSuggestionAdminRecoveryQuery({
      lookbackFrom: new Date('2026-09-01T00:00:00.000Z'),
      staleBefore: new Date('2026-09-03T00:00:00.000Z'),
      botKey: 'publisher:test-bot',
      publisherBotId: 'test-bot',
    });
    const senderIndexMigration = readFileSync(
      resolve(
        __dirname,
        '../../prisma/migrations/20260705103000_optimize_managed_entity_discovery_fallback/migration.sql',
      ),
      'utf8',
    );
    // Run embedded PostgreSQL outside Jest's VM so its WASM loader can use native imports.
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { readFileSync } from 'node:fs';
        import { PGlite } from '@electric-sql/pglite';
        const input = JSON.parse(readFileSync(0, 'utf8'));
        const database = new PGlite();
        try {
          await database.exec(input.schema);
          await database.exec(input.migration.replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
          await database.exec(input.senderIndexMigration.replaceAll('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
          await database.exec('ANALYZE audit_logs; ANALYZE channel_suggestion_admin_deliveries; ANALYZE webhook_events;');
          const result = await database.query(input.sql, input.values);
          const plan = await database.query('EXPLAIN (FORMAT JSON) ' + input.sql, input.values);
          const genericPlan = await database.exec('EXPLAIN (FORMAT JSON, GENERIC_PLAN TRUE) ' + input.legacySql);
          const parameterizedSql = input.legacySql.replace("action = 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'", 'action = $5::text');
          const oldGenericPlan = await database.exec('EXPLAIN (FORMAT JSON, GENERIC_PLAN TRUE) ' + parameterizedSql);
          const adminPlan = await database.exec('EXPLAIN (FORMAT JSON, GENERIC_PLAN TRUE) ' + input.adminSql);
          process.stdout.write(JSON.stringify({rows: result.rows, plan: plan.rows, genericPlan: genericPlan[0].rows, oldGenericPlan: oldGenericPlan[0].rows, adminPlan: adminPlan[0].rows}));
        } finally {
          await database.close();
        }
      `,
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          schema,
          migration,
          sql: query.text,
          values: query.values,
          legacySql: legacyQuery.text,
          adminSql: adminQuery.text,
          senderIndexMigration,
        }),
        timeout: 20_000,
        maxBuffer: 512 * 1024,
      },
    );
    expect({ status: child.status, error: child.error, stderr: child.stderr }).toEqual({
      status: 0,
      error: undefined,
      stderr: '',
    });
    const result = JSON.parse(child.stdout) as {
      rows: Array<{ id: string }>;
      plan: unknown;
      genericPlan: unknown;
      oldGenericPlan: unknown;
      adminPlan: unknown;
    };
    expect(result.rows.map((row) => row.id)).toEqual([
      'terminal-cancelled',
      'terminal-drafted',
      'terminal-published',
    ]);
    const serialized = JSON.stringify(result.plan);
    expect(serialized.match(/audit_logs_publisher_suggestion_status_created_idx/gu)).toHaveLength(
      3,
    );
    expect(serialized).not.toContain('audit_logs_action_created_at_idx');
    expect(JSON.stringify(result.genericPlan)).toContain(
      'audit_logs_publisher_suggestion_status_created_idx',
    );
    expect(JSON.stringify(result.genericPlan)).not.toContain('audit_logs_action_created_at_idx');
    expect(JSON.stringify(result.oldGenericPlan)).not.toContain(
      'audit_logs_publisher_suggestion_status_created_idx',
    );
    expect(
      JSON.stringify(result.adminPlan).match(/webhook_events_managed_sender_created_chat_idx/gu),
    ).toHaveLength(2);
  }, 30_000);
});
