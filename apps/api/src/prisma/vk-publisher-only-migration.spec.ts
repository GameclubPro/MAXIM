import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Publisher-only VK parsing migration', () => {
  it('deletes every Major scope and rejects its return', async () => {
    const scriptPath = join(__dirname, 'vk-publisher-only-migration.pglite.mjs');
    const migrationPath = join(
      __dirname,
      '../../prisma/migrations/20260829130000_restrict_vk_parsing_to_publisher/migration.sql',
    );

    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, migrationPath], {
      timeout: 30_000,
      maxBuffer: 1_000_000,
    });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
