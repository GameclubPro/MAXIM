import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('quarantined production legacy recovery entrypoint', () => {
  it.each(['preview', 'apply'])('refuses %s before reading input or opening stores', (mode) => {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', resolve(__dirname, 'recover-webhook-legacy-order.ts')],
      {
        encoding: 'utf8',
        timeout: 10_000,
        input: JSON.stringify({ mode, ownerIds: ['private-source-do-not-print'] }),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://secret-user:secret-pass@invalid.example/production',
          REDIS_URL: 'redis://secret-cache@invalid.example',
          MAXIM_LEGACY_RECOVERY_OFFLINE: '1',
          MAXIM_LEGACY_RECOVERY_ENABLED: '1',
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      applied: false,
      refused: true,
      code: 'cold_activation_disabled',
    });
    expect(result.stderr).toBe(
      'Legacy cold recovery activation is disabled; evidence is unchanged.\n',
    );
    expect(result.stdout + result.stderr).not.toMatch(/secret-|private-source|invalid\.example/u);
  });
});
