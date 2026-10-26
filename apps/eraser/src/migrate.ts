import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
export async function migrate(pool: pg.Pool): Promise<void> {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = (await readdir(directory)).filter((file) => /^\d[\w-]*\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('eraser:migrations:v1'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS eraser_migrations(name text PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    for (const file of files) {
      const sql = await readFile(`${directory}/${file}`, 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      const previous = await client.query<{ digest: string }>(
        'SELECT digest FROM eraser_migrations WHERE name=$1',
        [file],
      );
      if (previous.rows[0]) {
        if (previous.rows[0].digest !== digest) throw new Error(`Migration changed: ${file}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO eraser_migrations(name,digest) VALUES($1,$2)', [
        file,
        digest,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.ERASER_DATABASE_URL;
  if (!url) throw new Error('Missing ERASER_DATABASE_URL');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await migrate(pool);
    process.stdout.write('Eraser migrations applied.\n');
  } finally {
    await pool.end();
  }
}
