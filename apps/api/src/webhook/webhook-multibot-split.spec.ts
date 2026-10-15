import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MULTIBOT_HARNESS_POOLS,
  createMultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import { ALL_WEBHOOK_QUEUE_NAMES } from './webhook-queues';
import { resolveRuntimeServiceProfile } from '../runtime/runtime-topology';

describe('split local multibot fixture boundaries', () => {
  it('keeps the tested role pools equal to production and covers every static webhook queue once', () => {
    const compose = readFileSync(
      resolve(__dirname, '../../../../infra/docker-compose.yml'),
      'utf8',
    );
    const queues: string[] = [];
    let connections = 0;
    for (const [role, cap] of Object.entries(MULTIBOT_HARNESS_POOLS)) {
      const block = compose.match(
        new RegExp(`\\n  ${role}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`, 'u'),
      )?.[1];
      expect(block).toBeDefined();
      expect(Number(block?.match(/^\s{6}PRISMA_PG_POOL_MAX:\s*(\d+)\s*$/mu)?.[1])).toBe(cap);
      connections += cap;
      queues.push(
        ...resolveRuntimeServiceProfile({ APP_SERVICE_NAME: role }).service.moderationQueues,
      );
    }
    expect(connections).toBe(56);
    expect(queues.sort()).toEqual([...ALL_WEBHOOK_QUEUE_NAMES].sort());
    expect(new Set(queues).size).toBe(queues.length);
  });

  it.each([
    ['postgresql://invalid.invalid/race_test', 'redis://127.0.0.1:6379', 'local'],
    ['postgresql://127.0.0.1/production', 'redis://127.0.0.1:6379', 'local'],
    ['postgresql://127.0.0.1/race_test', 'redis://invalid.invalid', 'local'],
    ['postgresql://127.0.0.1/race_test', 'redis://127.0.0.1:6379', 'split'],
  ])(
    'refuses unsafe stores or an unowned run before connecting (%s)',
    async (databaseUrl, redisUrl, reason) => {
      await expect(
        createMultibotHarness({
          databaseUrl,
          redisUrl,
          bots: 6,
          split: { runId: 'not-an-owned-uuid', role: 'api-enqueue' },
        }),
      ).rejects.toThrow(reason === 'split' ? /split fixture identity/u : /disposable local/u);
    },
  );
});
