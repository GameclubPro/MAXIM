import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const guardedFiles = [
  {
    path: 'apps/api/src/moderation/rule-engine.service.ts',
    maxLines: 4100,
    reason: 'RuleEngineService should stay a facade while detectors move out.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.ts',
    maxLines: 18350,
    reason: 'ModerationService is a legacy hotspot; new behavior should move to focused modules.',
  },
  {
    path: 'apps/api/src/admin/admin.service.ts',
    maxLines: 29000,
    reason: 'AdminService is a legacy hotspot; new admin domains should live in focused services.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.tsx',
    maxLines: 13500,
    reason: 'SettingsPage should shrink into route shell, hooks, and workspaces.',
  },
  {
    path: 'apps/miniapp/src/styles/lazy-pages.css',
    maxLines: 24000,
    reason: 'Route/component styles should leave the compatibility bundle over time.',
  },
  {
    path: 'packages/contracts/src/index.ts',
    maxLines: 4100,
    reason: 'Contracts should continue moving to existing subpath exports.',
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
      'If this growth is intentional, update the guard in the same change with the architectural reason.',
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
