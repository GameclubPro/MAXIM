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
  'api-action': 3,
} as const;

describe('production compose Prisma pool caps', () => {
  const compose = readFileSync(resolve(__dirname, '../../../../infra/docker-compose.yml'), 'utf8');

  it('caps every API role below the Postgres cold-start budget', () => {
    let total = 0;

    for (const [service, expectedCap] of Object.entries(API_SERVICE_POOL_CAPS)) {
      const block = readServiceBlock(compose, service);
      const cap = readEnvNumber(block, 'PRISMA_PG_POOL_MAX');
      expect(cap).toBe(expectedCap);
      total += cap;
    }

    expect(total).toBe(45);
  });

  it('caps the dedicated managed-entities read client separately', () => {
    const adminBlock = readServiceBlock(compose, 'api-admin');

    expect(readEnvNumber(adminBlock, 'MANAGED_ENTITIES_READ_PRISMA_PG_POOL_MAX')).toBe(6);
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

function readEnvNumber(serviceBlock: string, key: string): number {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }

  return Number(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
