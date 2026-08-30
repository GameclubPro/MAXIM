import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('night mode transition durable migration', () => {
  it('preserves structured manual blocks and fences stale generations in PostgreSQL SQL', async () => {
    const scriptPath = join(__dirname, 'night-mode-transition-migration.pglite.mjs');
    const baseMigrationPath = join(
      __dirname,
      '../../prisma/migrations/20260821130000_add_night_mode_transition_reconcile_requests/migration.sql',
    );
    const acknowledgementMigrationPath = join(
      __dirname,
      '../../prisma/migrations/20260821140000_add_night_mode_transition_manual_acknowledgement/migration.sql',
    );
    const runtimeVersionMigrationPath = join(
      __dirname,
      '../../prisma/migrations/20260830013000_add_night_mode_scheduled_job_runtime_version/migration.sql',
    );
    const perChatRecoveryIndexMigrationPath = join(
      __dirname,
      '../../prisma/migrations/20260830014000_add_night_mode_per_chat_recovery_index/migration.sql',
    );

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        scriptPath,
        baseMigrationPath,
        acknowledgementMigrationPath,
        runtimeVersionMigrationPath,
        perChatRecoveryIndexMigrationPath,
      ],
      {
        timeout: 20_000,
        maxBuffer: 1_000_000,
      },
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
