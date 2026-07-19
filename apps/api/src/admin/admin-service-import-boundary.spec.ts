import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const API_SRC_ROOT = resolve(__dirname, '..');
const ADMIN_SERVICE_IMPORT_PATTERN = /from\s+['"][^'"]*admin\.service['"]/u;
const ALLOWED_ADMIN_SERVICE_IMPORTS = [
  'admin/admin-settings.service.ts',
  'admin/admin.module.ts',
  'admin/channel-dialog-legacy.port.ts',
  'admin/managed-entities-legacy.port.ts',
  'admin/managed-giveaway.service.ts',
  'admin/managed-poll.service.ts',
  'admin/manual-moderation.service.ts',
  'admin/vk-parsing-access.service.ts',
  'admin/vk-publish.service.ts',
  'moderation/private-control.service.legacy.ts',
  'moderation/private-control.service.ts',
] as const;

describe('AdminService production import boundary', () => {
  it('allows direct AdminService imports only in the ratcheted legacy boundary', () => {
    expect(findProductionAdminServiceImports()).toEqual([...ALLOWED_ADMIN_SERVICE_IMPORTS].sort());
  });
});

function findProductionAdminServiceImports(): string[] {
  return walkTypeScriptFiles(API_SRC_ROOT)
    .filter((filePath) => !filePath.endsWith('.spec.ts') && !filePath.endsWith('.test.ts'))
    .filter((filePath) => !filePath.includes('/generated/'))
    .filter((filePath) => ADMIN_SERVICE_IMPORT_PATTERN.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => relative(API_SRC_ROOT, filePath).split('\\').join('/'))
    .sort();
}

function walkTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      return walkTypeScriptFiles(filePath);
    }
    return filePath.endsWith('.ts') ? [filePath] : [];
  });
}
