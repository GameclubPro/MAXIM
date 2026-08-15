import type { PoolConfig } from 'pg';
import { createPrismaAdapter, readPrismaPoolConfig } from './prisma-client';

describe('prisma-client', () => {
  it('maps Prisma pool env vars to pg pool config', () => {
    expect(
      readPrismaPoolConfig({
        APP_SERVICE_NAME: 'api-admin',
        PRISMA_PG_POOL_MAX: '4',
        PRISMA_PG_POOL_IDLE_TIMEOUT_MS: '10000',
        PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS: '5000',
        PRISMA_PG_POOL_MAX_LIFETIME_SEC: '300',
        PRISMA_PG_STATEMENT_TIMEOUT_MS: '15000',
      }),
    ).toEqual({
      application_name: 'api-admin',
      max: 4,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      maxLifetimeSeconds: 300,
      statement_timeout: 15000,
    });
  });

  it('keeps backward-compatible Prisma pool env names', () => {
    expect(
      readPrismaPoolConfig({
        APP_ROLE: 'ingress',
        PRISMA_POOL_MAX: '3',
        PRISMA_POOL_IDLE_TIMEOUT_MS: '9000',
        PRISMA_POOL_CONNECTION_TIMEOUT_MS: '4000',
      }),
    ).toEqual({
      application_name: 'ingress',
      max: 3,
      idleTimeoutMillis: 9000,
      connectionTimeoutMillis: 4000,
    });
  });

  it('falls back to legacy pool env names when the new key is blank', () => {
    expect(
      readPrismaPoolConfig({
        PRISMA_PG_POOL_MAX: ' ',
        PRISMA_POOL_MAX: '2',
      }),
    ).toEqual({ max: 2 });
  });

  it('rejects invalid Prisma pool env values', () => {
    expect(() => readPrismaPoolConfig({ PRISMA_PG_POOL_MAX: '0' })).toThrow(
      /PRISMA_PG_POOL_MAX must be a positive integer/u,
    );
    expect(() => readPrismaPoolConfig({ PRISMA_PG_POOL_IDLE_TIMEOUT_MS: 'NaN' })).toThrow(
      /PRISMA_PG_POOL_IDLE_TIMEOUT_MS must be a positive integer/u,
    );
    expect(() => readPrismaPoolConfig({ PRISMA_PG_STATEMENT_TIMEOUT_MS: '0' })).toThrow(
      /PRISMA_PG_STATEMENT_TIMEOUT_MS must be a positive integer/u,
    );
  });

  it('passes the documented pg pool config shape to PrismaPg', () => {
    const adapter = createPrismaAdapter(
      ' postgresql://maxim:maxim@localhost:5432/maxim?schema=public ',
      {
        max: 3,
        idleTimeoutMillis: 9000,
        connectionTimeoutMillis: 4000,
        application_name: 'api-test',
      },
    );

    const internals = adapter as unknown as { config: PoolConfig; options?: { schema?: string } };

    expect(internals.config).toMatchObject({
      connectionString: 'postgresql://maxim:maxim@localhost:5432/maxim?schema=public',
      max: 3,
      idleTimeoutMillis: 9000,
      connectionTimeoutMillis: 4000,
      application_name: 'api-test',
    });
    expect(internals.options).toEqual({ schema: 'public' });
  });
});
