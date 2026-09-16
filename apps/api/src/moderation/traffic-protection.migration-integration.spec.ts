import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const url = process.env.MAXIM_TEST_POSTGRES_URL ?? '';
const local = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);

(local ? describe : describe.skip)('traffic policy migration', () => {
  let client: Client;
  beforeEach(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    const schema = `traffic_test_${randomUUID().replaceAll('-', '')}`;
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(
      'CREATE TABLE chat_settings (id TEXT PRIMARY KEY, unrelated BOOLEAN NOT NULL DEFAULT false)',
    );
    await client.query("INSERT INTO chat_settings (id) VALUES ('existing')");
    await client.query(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20260916230000_add_chat_traffic_protection/migration.sql',
        ),
        'utf8',
      ),
    );
  });
  afterEach(async () => {
    await client.query('ROLLBACK');
    await client.end();
  });

  it('preserves existing behavior and invalidates revisions only for policy changes', async () => {
    const read = async () =>
      (await client.query("SELECT * FROM chat_settings WHERE id = 'existing'")).rows[0];
    expect(await read()).toMatchObject({
      slow_mode_enabled: false,
      media_message_cooldown_enabled: false,
      sticker_messages_enabled: true,
      traffic_policy_revision: 0,
    });
    await client.query("UPDATE chat_settings SET slow_mode_enabled = true WHERE id = 'existing'");
    expect((await read()).traffic_policy_revision).toBe(1);
    await client.query(
      "UPDATE chat_settings SET unrelated = true, traffic_policy_revision = 0 WHERE id = 'existing'",
    );
    expect((await read()).traffic_policy_revision).toBe(1);
    await client.query("UPDATE chat_settings SET slow_mode_enabled = false WHERE id = 'existing'");
    await client.query("UPDATE chat_settings SET slow_mode_enabled = true WHERE id = 'existing'");
    expect((await read()).traffic_policy_revision).toBe(3);
  });
  it('does not accept forged activation dates or revisions at creation', async () => {
    const result = await client.query(
      "INSERT INTO chat_settings (id, traffic_policy_revision, traffic_policy_effective_at) VALUES ('new', 999, '2000-01-01') RETURNING *",
    );
    expect(result.rows[0].traffic_policy_revision).toBe(0);
    expect(result.rows[0].traffic_policy_effective_at.getFullYear()).toBe(new Date().getFullYear());
  });
  it('rejects invalid intervals in direct database writes', async () => {
    await expect(
      client.query("UPDATE chat_settings SET slow_mode_interval_seconds = 0 WHERE id = 'existing'"),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
