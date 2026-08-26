import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Publik dispatch migrations', () => {
  it('enforces parent-derived routes, signed contexts, and immutable VK provenance', async () => {
    const scriptPath = join(__dirname, 'publisher-dispatch-migration.pglite.mjs');
    const migrationRoot = join(__dirname, '../../prisma/migrations');
    const migrationPaths = [
      '20260826120000_add_publisher_dispatch_foundation',
      '20260826121000_index_publisher_dispatch_claims',
      '20260826122000_add_vk_publisher_dispatch',
      '20260826123000_add_publisher_dialog_context',
    ].map((name) => join(migrationRoot, name, 'migration.sql'));

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [scriptPath, ...migrationPaths],
      { timeout: 30_000, maxBuffer: 1_000_000 },
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
