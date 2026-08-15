import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';

import { PrismaClient } from '../generated/prisma/client';

export * from '../generated/prisma/client';

export type PrismaPoolConfig = Pick<
  PoolConfig,
  | 'application_name'
  | 'connectionTimeoutMillis'
  | 'idleTimeoutMillis'
  | 'max'
  | 'maxLifetimeSeconds'
  | 'options'
  | 'statement_timeout'
>;

export function readPrismaPoolConfig(env: Record<string, unknown> = process.env): PrismaPoolConfig {
  const applicationName =
    readOptionalString(env, 'APP_SERVICE_NAME') ?? readOptionalString(env, 'APP_ROLE');

  return {
    ...(applicationName ? { application_name: applicationName } : {}),
    ...readOptionalPositiveInt(env, 'PRISMA_PG_POOL_MAX', 'max', 'PRISMA_POOL_MAX'),
    ...readOptionalPositiveInt(
      env,
      'PRISMA_PG_POOL_IDLE_TIMEOUT_MS',
      'idleTimeoutMillis',
      'PRISMA_POOL_IDLE_TIMEOUT_MS',
    ),
    ...readOptionalPositiveInt(
      env,
      'PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS',
      'connectionTimeoutMillis',
      'PRISMA_POOL_CONNECTION_TIMEOUT_MS',
    ),
    ...readOptionalPositiveInt(env, 'PRISMA_PG_POOL_MAX_LIFETIME_SEC', 'maxLifetimeSeconds'),
    ...readOptionalPositiveInt(env, 'PRISMA_PG_STATEMENT_TIMEOUT_MS', 'statement_timeout'),
  };
}

export function createPrismaAdapter(
  databaseUrl = process.env.DATABASE_URL,
  poolConfig = readPrismaPoolConfig(),
): PrismaPg {
  if (!databaseUrl?.trim()) {
    throw new Error('DATABASE_URL is required to initialize PrismaClient');
  }

  const connectionString = databaseUrl.trim();

  return new PrismaPg(
    {
      connectionString,
      ...poolConfig,
    },
    readPrismaPgOptions(connectionString),
  );
}

export function createPrismaClient(
  databaseUrl?: string,
  poolConfig?: PrismaPoolConfig,
): PrismaClient {
  return new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, poolConfig),
  });
}

function readOptionalPositiveInt(
  env: Record<string, unknown>,
  key: string,
  pgKey: keyof PrismaPoolConfig,
  legacyKey?: string,
): PrismaPoolConfig {
  const primaryValue = readRawEnvValue(env, key);
  const usingPrimary = primaryValue !== null;
  const actualKey = usingPrimary ? key : legacyKey;
  const value = usingPrimary ? primaryValue : actualKey ? readRawEnvValue(env, actualKey) : null;
  if (value === undefined || value === null) {
    return {};
  }

  const numericValue = Number(value);
  if (!Number.isInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${actualKey ?? key} must be a positive integer`);
  }

  return { [pgKey]: numericValue } as PrismaPoolConfig;
}

function readRawEnvValue(env: Record<string, unknown>, key: string): string | null {
  const value = env[key];
  if (value === undefined || value === null) {
    return null;
  }

  const rawValue = String(value).trim();
  return rawValue.length > 0 ? rawValue : null;
}

function readOptionalString(env: Record<string, unknown>, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readPrismaPgOptions(connectionString: string): { schema?: string } | undefined {
  try {
    const schema = new URL(connectionString).searchParams.get('schema')?.trim();
    return schema ? { schema } : undefined;
  } catch {
    return undefined;
  }
}
