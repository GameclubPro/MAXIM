import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const targetDate = '2026-06-26';

const guardedFiles = [
  {
    path: 'apps/api/src/admin/admin.service.legacy.ts',
    maxLines: 28582,
    targetLines: 23000,
    reason:
      'AdminService implementation is a legacy hotspot; managed entities, broadcasts, settings, and rules should keep moving to focused services.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.legacy.ts',
    maxLines: 18255,
    targetLines: 15500,
    reason:
      'ModerationService implementation is a legacy hotspot; explanation, access, global spammer, and night-mode helpers should keep moving to focused modules.',
  },
  {
    path: 'apps/api/src/moderation/private-control.service.legacy.ts',
    maxLines: 13599,
    targetLines: 10500,
    reason:
      'PrivateControlService is a legacy hotspot; session, draft normalization, and render builders should keep moving to focused modules.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.legacy.tsx',
    maxLines: 11358,
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
    maxLines: 3407,
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
const ignoredDirectoryNames = new Set([
  '.git',
  'coverage',
  'dist',
  'node_modules',
]);
const legacyImportPattern =
  /\b(?:import|export)\b[\s\S]*?\bfrom\s+['"][^'"]*\.legacy(?:\.[^'"]+)?['"]|import\s*\(\s*['"][^'"]*\.legacy(?:\.[^'"]+)?['"]\s*\)/u;

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
