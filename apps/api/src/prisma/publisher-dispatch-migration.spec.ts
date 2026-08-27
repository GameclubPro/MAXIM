import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Publik dispatch migrations', () => {
  it('enforces parent-derived routes, signed contexts, and immutable VK provenance', async () => {
    const scriptPath = join(__dirname, 'publisher-dispatch-migration.pglite.mjs');
    const migrationRoot = join(__dirname, '../../prisma/migrations');
    const expandMigrationNames = [
      '20260826120000_add_publisher_dispatch_foundation',
      '20260826121000_index_publisher_dispatch_claims',
      '20260826122000_add_vk_publisher_dispatch',
      '20260826123000_add_publisher_dialog_context',
      '20260827120000_allow_publisher_owned_dialog_routes',
      '20260827121000_add_publisher_entity_settings',
      '20260827122000_add_vk_parsing_owner_scope',
      '20260827123000_create_vk_parsing_owner_scope_indexes',
    ];
    const contractMigrationNames = [
      '20260827124000_drop_vk_parsing_settings_legacy_unique',
      '20260827125000_drop_vk_parsing_sources_legacy_unique',
      '20260827126000_drop_vk_parsing_posts_legacy_unique',
    ];
    const migrationPaths = [...expandMigrationNames, ...contractMigrationNames]
      .map((name) => join(migrationRoot, name, 'migration.sql'))
      .filter(existsSync);

    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [scriptPath, ...migrationPaths],
      { timeout: 30_000, maxBuffer: 1_000_000 },
    );

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  });
});
