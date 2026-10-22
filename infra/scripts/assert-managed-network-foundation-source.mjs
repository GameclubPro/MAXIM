import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: The applied migration is the durable installation receipt. Disabling new
// network requests cannot retire pending operations, COMMITTED receipts or CAS writers.
export const MANAGED_NETWORK_FOUNDATION_MIGRATION = '20261022120000_add_managed_network_foundation';

export const MANAGED_NETWORK_FOUNDATION_SOURCE_CHECKS = Object.freeze([
  [
    `apps/api/prisma/migrations/${MANAGED_NETWORK_FOUNDATION_MIGRATION}/migration.sql`,
    [
      'NEW.revision := OLD.revision + 1;',
      'CREATE TRIGGER "channel_settings_revision_guard" BEFORE UPDATE ON "channel_settings"',
      'CREATE TABLE "network_settings_operations"',
      'CREATE TABLE "network_settings_operation_targets"',
      '"committed_revision" TEXT',
    ],
  ],
  [
    'apps/api/src/admin/admin.module.ts',
    [
      "import { NetworkSettingsService } from './network-settings.service';",
      "import { NetworkSettingsRunnerService } from './network-settings-runner.service';",
      'NetworkSettingsService,',
      '...(roleRunsAction(getAppRole()) ? [NetworkSettingsRunnerService] : [])',
    ],
  ],
  [
    'apps/api/src/admin/network-settings-runner.service.ts',
    [
      'private readonly settings: NetworkSettingsService',
      'if (!roleRunsAction(getAppRole())) return;',
      'this.settings.tick(2)',
      'await this.inFlight;',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    [
      "const ACTIVE_STATUSES = ['PREVIEWING', 'AUTHORIZING', 'RUNNING'];",
      'status: { in: ACTIVE_STATUSES }',
      'OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }]',
      "if (target.status !== 'COMMITTED')",
      'deferFollowup: true',
      'onCommitted: async (tx, revision) =>',
      "leaseToken, status: 'RUNNING', leaseUntil: { gt: new Date() }",
      "data: { status: 'COMMITTED', committedRevision: revision }",
      "if (committed.status === 'COMMITTED')",
      'await this.settings.finishNetworkSettingsFollowup(',
      "where: { operationId, entityId: target.entityId, status: 'COMMITTED' }",
    ],
  ],
  [
    'apps/api/src/admin/admin-channel-settings.ts',
    [
      'if (parsed.data.revision === undefined)',
      'where: { chatId: params.chatId, revision: parsed.data.revision }',
      'data: { ...settingsToUpdate, revision: { increment: 1 } }',
      'if (!changed.count)',
      'await params.networkWrite?.onCommitted?.(tx, String(savedRevision));',
      'if (params.networkWrite?.deferFollowup) return',
    ],
  ],
  [
    'apps/api/src/admin/channel-post-signature.service.ts',
    [
      'if (lockedCurrent.revision !== expectedRevision) throw this.revisionConflict();',
      'where: { chatId, revision: expectedRevision }',
      'data: { ...data, revision: { increment: 1 } }',
      'if (written.count !== 1) throw this.revisionConflict();',
      'await networkWrite?.onCommitted?.(tx, String(written.revision));',
    ],
  ],
  [
    'apps/api/src/admin/admin-chat-settings.ts',
    [
      'if (params.networkWrite?.onCommitted)',
      'await params.networkWrite.onCommitted(tx, savedRevision);',
      'if (params.networkWrite?.deferFollowup) return resultingSettings;',
    ],
  ],
  [
    'apps/api/src/admin/admin-stop-words.service.ts',
    [
      'if (networkWrite?.onCommitted)',
      'await networkWrite.onCommitted(tx, written.updatedAt.toISOString());',
      'if (!networkWrite?.deferFollowup && !networkWrite?.validateOnly)',
    ],
  ],
]);

const executable = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--).*$/gmu, '')
    .replace(/\s+/gu, '');

export function assertManagedNetworkFoundationSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, fragments] of MANAGED_NETWORK_FOUNDATION_SOURCE_CHECKS) {
    const source = readSource(path);
    const normalized = typeof source === 'string' ? executable(source) : '';
    const missing = fragments.find(
      (fragment) => !normalized.includes(fragment.replace(/\s+/gu, '')),
    );
    if (missing)
      throw new Error(
        `Rollback target lacks managed network foundation readers/writers: ${path} (${missing})`,
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertManagedNetworkFoundationSource(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
