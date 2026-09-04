import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('VK pending autopublish recovery index', () => {
  it('serves the bounded source recovery query through the partial index', async () => {
    const scriptPath = join(__dirname, 'vk-pending-autopublish-index.pglite.mjs');
    const migrationPath = join(
      __dirname,
      '../../prisma/migrations/20260904131000_index_vk_pending_autopublish_recovery/migration.sql',
    );

    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, migrationPath], {
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
