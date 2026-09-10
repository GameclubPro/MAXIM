import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildPublisherSuggestionAdminTerminalSyncRecoveryQuery } from './publisher-suggestion-admin-recovery.service';

describe('Publisher suggestion recovery PostgreSQL plan', () => {
  it('uses the status/cursor index without scanning unrelated suggestion states', () => {
    const schema = `
        CREATE TYPE "ChannelSuggestionAdminDeliveryStatus" AS ENUM ('SENT');
        CREATE TABLE audit_logs (
          id text PRIMARY KEY, action text NOT NULL, payload jsonb NOT NULL,
          created_at timestamp NOT NULL
        );
        CREATE TABLE channel_suggestion_admin_deliveries (
          audit_log_id text, bot_key text, status "ChannelSuggestionAdminDeliveryStatus",
          private_chat_id text, remote_message_id text
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
        INSERT INTO channel_suggestion_admin_deliveries
        SELECT id, 'publisher:test-bot', 'SENT', 'private-dialog', 'card'
        FROM audit_logs WHERE id LIKE 'terminal-%';
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
          await database.exec('ANALYZE audit_logs; ANALYZE channel_suggestion_admin_deliveries;');
          const result = await database.query(input.sql, input.values);
          const plan = await database.query('EXPLAIN (FORMAT JSON) ' + input.sql, input.values);
          process.stdout.write(JSON.stringify({rows: result.rows, plan: plan.rows}));
        } finally {
          await database.close();
        }
      `,
      ],
      {
        encoding: 'utf8',
        input: JSON.stringify({ schema, migration, sql: query.text, values: query.values }),
        timeout: 20_000,
        maxBuffer: 512 * 1024,
      },
    );
    expect({ status: child.status, error: child.error, stderr: child.stderr }).toEqual({
      status: 0,
      error: undefined,
      stderr: '',
    });
    const result = JSON.parse(child.stdout) as { rows: Array<{ id: string }>; plan: unknown };
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
  }, 30_000);
});
