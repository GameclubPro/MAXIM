import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const targetDate = '2026-06-26';

const guardedFiles = [
  {
    path: 'apps/api/src/admin/admin.service.legacy.ts',
    maxLines: 28861,
    targetLines: 23000,
    reason:
      'AdminService implementation is a legacy hotspot; managed entities, broadcasts, settings, and rules should keep moving to focused services.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.legacy.ts',
    maxLines: 18184,
    targetLines: 15500,
    reason:
      'ModerationService implementation is a legacy hotspot; explanation, access, global spammer, and night-mode helpers should keep moving to focused modules.',
  },
  {
    path: 'apps/api/src/moderation/private-control.service.legacy.ts',
    maxLines: 13274,
    targetLines: 10500,
    reason:
      'PrivateControlService is a legacy hotspot; session, draft normalization, and render builders should keep moving to focused modules.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.legacy.tsx',
    maxLines: 11473,
    targetLines: 8500,
    reason: 'SettingsPage should shrink into route shell, hooks, and workspaces.',
  },
  {
    path: 'apps/miniapp/src/styles/lazy-pages.css',
    maxLines: 11449,
    targetLines: 9500,
    reason: 'Route/component styles should leave the compatibility bundle over time.',
  },
  {
    path: 'packages/contracts/src/core.ts',
    maxLines: 3442,
    targetLines: 3000,
    reason: 'Contracts should continue moving to existing subpath exports.',
  },
];

const allowedLegacyImportFiles = new Set([
  'apps/api/src/admin/admin.service.impl.ts',
  'apps/api/src/admin/admin.service.ts',
  'apps/api/src/moderation/moderation.service.impl.ts',
  'apps/api/src/moderation/moderation.service.ts',
  'apps/api/src/moderation/private-control.service.ts',
  'apps/miniapp/src/pages/settings-page.tsx',
]);

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const ignoredDirectoryNames = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const legacyImportPattern =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+['"][^'"]*\.legacy(?:\.[^'"]+)?['"]|import\s*\(\s*['"][^'"]*\.legacy(?:\.[^'"]+)?['"]\s*\)/u;

const runtimeEntrypointBoundaryGuards = [
  {
    path: 'apps/api/src/webhook/webhook.controller.ts',
    boundary: 'WebhookIngestionService',
    patterns: [
      {
        pattern: /\bWebhookService\b/u,
        reason:
          'Controllers should keep webhook signature, parsing, rate-limit, and outbox ingestion behind WebhookIngestionService.',
      },
      {
        pattern: /\bWebhookParser\b/u,
        reason: 'Webhook parsing belongs inside the ingestion boundary, not the public controller.',
      },
    ],
  },
  {
    path: 'apps/api/src/max/max-action.processor.ts',
    boundary: 'MaxActionDispatchService',
    patterns: [
      {
        pattern: /\bMaxClientService\b/u,
        reason:
          'Action workers should dispatch through MaxActionDispatchService so MAX API execution can be isolated from processor topology.',
      },
      {
        pattern: /\bexecuteActionJob\s*\(/u,
        reason: 'Action workers should not call MaxClientService.executeActionJob directly.',
      },
    ],
  },
  {
    path: 'apps/api/src/moderation/default-webhook-lease-manager.service.ts',
    boundary: 'ModerationExecutionService',
    patterns: [
      {
        pattern: /\bModerationService\b/u,
        reason:
          'Dynamic moderation workers should execute through ModerationExecutionService instead of depending on the legacy moderation service.',
      },
      {
        pattern: /\bmoderationService\.processWebhookEvent\s*\(/u,
        reason:
          'Dynamic moderation workers should call ModerationExecutionService.processWebhookEvent.',
      },
    ],
  },
  {
    path: 'apps/api/src/admin/admin-managed-entities-refresh.processor.ts',
    boundary: 'ManagedEntitiesDiscoveryService',
    patterns: [
      {
        pattern: /\bAdminService\b/u,
        reason:
          'Managed-entities refresh workers should stay behind the discovery boundary instead of reaching legacy admin directly.',
      },
      {
        pattern: /\bManagedEntitiesService\b/u,
        reason:
          'Managed-entities refresh workers should use ManagedEntitiesDiscoveryService as the runtime discovery boundary.',
      },
      {
        pattern:
          /\b(?:adminService|managedEntitiesService)\.processManagedEntitiesRefreshJob\s*\(/u,
        reason:
          'Managed-entities refresh workers should dispatch through ManagedEntitiesDiscoveryService.',
      },
    ],
  },
];

let failed = false;

for (const guard of guardedFiles) {
  const contents = readFileSync(resolve(root, guard.path), 'utf8');
  const lines = countLines(contents);
  if (lines <= guard.maxLines) {
    continue;
  }

  failed = true;
  console.error(
    [
      `${guard.path} has ${lines} lines, over the ${guard.maxLines} refactor guard.`,
      guard.reason,
      `Target by ${targetDate}: ${guard.targetLines} lines or fewer.`,
      'If this growth is intentional, update the guard in the same change with the architectural reason.',
    ].join('\n'),
  );
}

for (const violation of findLegacyImportViolations(root)) {
  failed = true;
  console.error(
    [
      `${violation.path} imports a *.legacy module directly.`,
      'Legacy modules must stay hidden behind their thin facade files so future extraction work has one stable boundary.',
      `Allowed facade files: ${Array.from(allowedLegacyImportFiles).join(', ')}`,
    ].join('\n'),
  );
}

for (const violation of findRuntimeEntrypointBoundaryViolations(root)) {
  failed = true;
  console.error(
    [
      `${violation.path} bypasses ${violation.boundary}.`,
      violation.reason,
      'Route new runtime/admin hot-path code through the focused boundary service before touching legacy implementations.',
    ].join('\n'),
  );
}

if (failed) {
  process.exitCode = 1;
}

function countLines(value) {
  if (!value) {
    return 0;
  }

  return value.split(/\r?\n/u).length - (value.endsWith('\n') ? 1 : 0);
}

function findLegacyImportViolations(directory) {
  const violations = [];

  for (const filePath of walkSourceFiles(directory)) {
    const repoPath = toRepoPath(filePath);
    if (allowedLegacyImportFiles.has(repoPath)) {
      continue;
    }

    const contents = readFileSync(filePath, 'utf8');
    if (legacyImportPattern.test(contents)) {
      violations.push({ path: repoPath });
    }
  }

  return violations;
}

function findRuntimeEntrypointBoundaryViolations(directory) {
  const violations = [];

  for (const guard of runtimeEntrypointBoundaryGuards) {
    const filePath = resolve(directory, guard.path);
    const contents = readFileSync(filePath, 'utf8');
    for (const item of guard.patterns) {
      if (item.pattern.test(contents)) {
        violations.push({
          path: guard.path,
          boundary: guard.boundary,
          reason: item.reason,
        });
      }
    }
  }

  return violations;
}

function walkSourceFiles(directory) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      if (ignoredDirectoryNames.has(entry)) {
        continue;
      }
      files.push(...walkSourceFiles(entryPath));
      continue;
    }

    if (stats.isFile() && sourceExtensions.has(readExtension(entry))) {
      files.push(entryPath);
    }
  }

  return files;
}

function readExtension(fileName) {
  const index = fileName.lastIndexOf('.');
  return index >= 0 ? fileName.slice(index) : '';
}

function toRepoPath(filePath) {
  return relative(root, filePath).split('\\').join('/');
}
