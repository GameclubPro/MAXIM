import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { ConnectionAdmissionPool } from './connection-admission-pool';
import { createPrismaAdapter, createPrismaClient } from './prisma-client';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describeStores = databaseUrl ? describe : describe.skip;
// Cold transport setup is not the queue-wait behavior exercised by the short-timeout tests.
const lifecyclePoolConfig = { max: 1, connectionTimeoutMillis: 5_000 };

describeStores('PostgreSQL connection admission under an occupied pool', () => {
  let verifier: Pool;
  const table = `admission_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Connection admission tests require disposable local stores');
    verifier = new Pool({ connectionString: databaseUrl, max: 1 });
    await verifier.query(`CREATE TABLE ${table} (id text PRIMARY KEY)`);
    await verifier.query(`CREATE SEQUENCE ${table}_attempts`);
  });
  afterAll(async () => {
    if (!verifier) return;
    await verifier.query(`DROP TABLE IF EXISTS ${table}`);
    await verifier.query(`DROP SEQUENCE IF EXISTS ${table}_attempts`);
    await verifier.end();
  });

  it('reproduces the original pg-pool timeout before SQL runs', async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 60 });
    const occupied = await pool.connect();
    try {
      await expect(pool.query(`INSERT INTO ${table} VALUES ('original')`)).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      expect((await verifier.query(`SELECT id FROM ${table} WHERE id = 'original'`)).rows).toEqual(
        [],
      );
    } finally {
      occupied.release();
      await pool.end();
    }
  });

  it('admits one write after the first queue wait expires, without repeating SQL', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 80,
    });
    const occupied = await pool.connect();
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        occupied.release();
      }
    };
    const release = setTimeout(releaseOnce, 120);
    try {
      await pool.query(`INSERT INTO ${table} VALUES ('recovered')`);
      expect((await verifier.query(`SELECT id FROM ${table} WHERE id = 'recovered'`)).rows).toEqual(
        [{ id: 'recovered' }],
      );
      expect(pool.totalCount).toBe(1);
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
    } finally {
      clearTimeout(release);
      releaseOnce();
      await pool.end();
    }
  });

  it('preserves the callback connect API and releases the connection once', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 80,
    });
    const occupied = await pool.connect();
    let released = false;
    const releaseOnce = () => {
      if (!released) {
        released = true;
        occupied.release();
      }
    };
    const timer = setTimeout(releaseOnce, 120);
    let callbacks = 0;
    try {
      const client = await new Promise<PoolClient>((resolve, reject) =>
        pool.connect((error, connection) => {
          callbacks++;
          if (error) reject(error);
          else resolve(connection!);
        }),
      );
      expect((await client.query('SELECT 7 AS value')).rows[0]).toEqual({ value: 7 });
      client.release();
      expect(callbacks).toBe(1);
      expect(pool.waitingCount).toBe(0);
      expect(pool.idleCount).toBe(1);
    } finally {
      clearTimeout(timer);
      releaseOnce();
      await pool.end();
    }
  });

  it('stops after two bounded waits and leaves no abandoned waiter', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 60,
    });
    const occupied = await pool.connect();
    const started = Date.now();
    try {
      await expect(pool.query('SELECT 1')).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      expect(Date.now() - started).toBeGreaterThanOrEqual(110);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(pool.waitingCount).toBe(0);
    } finally {
      occupied.release();
      await pool.query('SELECT 1');
      expect(pool.totalCount).toBe(1);
      await pool.end();
    }
  });

  it('never retries a dispatched query even when its error matches the admission text', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      ...lifecyclePoolConfig,
    });
    try {
      await expect(
        pool.query(`DO $$ BEGIN
        PERFORM nextval('${table}_attempts');
        RAISE EXCEPTION 'timeout exceeded when trying to connect';
      END $$`),
      ).rejects.toThrow('timeout exceeded when trying to connect');
      expect(
        (await verifier.query(`SELECT last_value FROM ${table}_attempts`)).rows[0].last_value,
      ).toBe('1');
    } finally {
      await pool.end();
    }
  });

  it('does not start another admission after pool shutdown begins', async () => {
    const pool = new ConnectionAdmissionPool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 60,
    });
    const occupied = await pool.connect();
    const pending = expect(pool.query('SELECT 1')).rejects.toThrow(
      'timeout exceeded when trying to connect',
    );
    const ended = pool.end();
    try {
      await pending;
      expect(pool.waitingCount).toBe(0);
    } finally {
      occupied.release();
      await ended;
    }
    expect(pool.ended).toBe(true);
  });

  it('does not replay a Prisma transaction after a dispatched SQL failure', async () => {
    const prisma = createPrismaClient(databaseUrl, lifecyclePoolConfig);
    let attempts = 0;
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          attempts++;
          await tx.$executeRawUnsafe(`INSERT INTO ${table} VALUES ('rolled-back')`);
          await tx.$executeRawUnsafe(`DO $$ BEGIN
            RAISE EXCEPTION 'timeout exceeded when trying to connect';
          END $$`);
        }),
      ).rejects.toThrow('timeout exceeded when trying to connect');
      expect(attempts).toBe(1);
      expect(
        (await verifier.query(`SELECT id FROM ${table} WHERE id = 'rolled-back'`)).rows,
      ).toEqual([]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('owns a new bounded pool after adapter disposal and Prisma reconnect', async () => {
    const factory = createPrismaAdapter(databaseUrl, lifecyclePoolConfig);
    const first = await factory.connect();
    const firstPool = first.underlyingDriver() as Pool;
    try {
      expect(firstPool).toBeInstanceOf(ConnectionAdmissionPool);
      expect(firstPool.options).toMatchObject(lifecyclePoolConfig);
      await firstPool.query('SELECT 1');
    } finally {
      await first.dispose();
    }
    expect(firstPool.ended).toBe(true);
    const second = await factory.connect();
    const secondPool = second.underlyingDriver() as Pool;
    try {
      expect(secondPool).not.toBe(firstPool);
      expect(secondPool).toBeInstanceOf(ConnectionAdmissionPool);
      expect(secondPool.options).toMatchObject(lifecyclePoolConfig);
      await secondPool.query('SELECT 1');
    } finally {
      await second.dispose();
    }
    expect(secondPool.ended).toBe(true);

    const prisma = createPrismaClient(databaseUrl, lifecyclePoolConfig);
    try {
      await prisma.$queryRaw`SELECT 1`;
      await prisma.$disconnect();
      await prisma.$queryRaw`SELECT 1`;
    } finally {
      await prisma.$disconnect();
    }
  });
});
