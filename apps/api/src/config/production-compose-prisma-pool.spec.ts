import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API_SERVICE_POOL_CAPS = {
  'api-ingress': 6,
  'api-admin': 10,
  'api-enqueue': 4,
  'api-moderation': 3,
  'api-moderation-critical': 4,
  'api-moderation-join': 4,
  'api-moderation-realtime-b': 3,
  'api-moderation-realtime-c': 3,
  'api-moderation-realtime-d': 3,
  'api-moderation-background': 2,
  'api-media-analysis': 2,
  'api-action': 4,
  'api-publisher': 2,
} as const;

const API_SERVICE_POOL_CONNECTION_TIMEOUT_MS = {
  'api-action': 20_000,
  'api-publisher': 20_000,
} as const satisfies Partial<Record<keyof typeof API_SERVICE_POOL_CAPS, number>>;

const COMPOSE_FILES = [
  ['main', '../../../../infra/docker-compose.yml'],
  ['scale', '../../../../infra/docker-compose.scale.yml'],
] as const;

describe('production compose Prisma pool caps', () => {
  describe.each(COMPOSE_FILES)('%s compose', (_name, composePath) => {
    const compose = readFileSync(resolve(__dirname, composePath), 'utf8');

    it('caps every API role below the Postgres cold-start budget', () => {
      let total = 0;

      for (const [service, expectedCap] of Object.entries(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const cap = readEnvNumber(block, 'PRISMA_PG_POOL_MAX');
        expect(cap).toBe(expectedCap);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_IDLE_TIMEOUT_MS')).toBe(10_000);
        expect(readEnvNumber(block, 'PRISMA_PG_POOL_CONNECTION_TIMEOUT_MS')).toBe(
          API_SERVICE_POOL_CONNECTION_TIMEOUT_MS[
            service as keyof typeof API_SERVICE_POOL_CONNECTION_TIMEOUT_MS
          ] ?? 5_000,
        );
        total += cap;
      }

      expect(total).toBe(50);
    });

    it('caps the dedicated managed-entities read client separately', () => {
      const adminBlock = readServiceBlock(compose, 'api-admin');

      expect(readEnvNumber(adminBlock, 'MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX')).toBe(6);
    });

    it('bounds long statements on the webhook ingress role only', () => {
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);

        expect(readOptionalEnvNumber(block, 'PRISMA_PG_STATEMENT_TIMEOUT_MS')).toBe(
          service === 'api-ingress' ? 15_000 : null,
        );
      }
    });

    it('keeps webhook outbox enqueue work owned by the enqueue role only', () => {
      for (const service of Object.keys(API_SERVICE_POOL_CAPS)) {
        const block = readServiceBlock(compose, service);
        const appRole = readEnvString(block, 'APP_ROLE');

        expect(appRole).not.toBe('all');
        expect(appRole === 'enqueue').toBe(service === 'api-enqueue');
      }
    });

    it('persists Redis /data on an explicit named volume', () => {
      const redisBlock = readServiceBlock(compose, 'redis');
      const volumesBlock = readTopLevelVolumesBlock(compose);

      expect(redisBlock).toMatch(/^\s{4}volumes:\n\s{6}- redis_data:\/data\s*$/mu);
      expect(volumesBlock).toMatch(/^\s{2}redis_data:\s*$/mu);
    });
  });
});

function readServiceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`,
      'u',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose service ${service}`);
  }

  return match[1];
}

function readTopLevelVolumesBlock(compose: string): string {
  const match = compose.match(/\nvolumes:\n([\s\S]*)$/u);

  if (!match?.[1]) {
    throw new Error('Missing top-level compose volumes block');
  }

  return match[1];
}

function readEnvNumber(serviceBlock: string, key: string): number {
  const value = readOptionalEnvNumber(serviceBlock, key);
  if (value === null) {
    throw new Error(`Missing compose env ${key}`);
  }

  return value;
}

function readOptionalEnvNumber(serviceBlock: string, key: string): number | null {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    return null;
  }

  return Number(match[1]);
}

function readEnvString(serviceBlock: string, key: string): string {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([^'\\n]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }

  return match[1].trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
