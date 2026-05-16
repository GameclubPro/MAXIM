import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const targetDate = '2026-06-26';

const guardedFiles = [
  {
    path: 'apps/api/src/admin/admin.service.impl.ts',
    maxLines: 28534,
    targetLines: 23000,
    reason:
      'AdminService implementation is a legacy hotspot; managed entities, broadcasts, settings, and rules should keep moving to focused services.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.impl.ts',
    maxLines: 18121,
    targetLines: 15500,
    reason:
      'ModerationService implementation is a legacy hotspot; explanation, access, global spammer, and night-mode helpers should keep moving to focused modules.',
  },
  {
    path: 'apps/api/src/moderation/private-control.service.ts',
    maxLines: 13599,
    targetLines: 10500,
    reason:
      'PrivateControlService is a legacy hotspot; session, draft normalization, and render builders should keep moving to focused modules.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.tsx',
    maxLines: 11405,
    targetLines: 8500,
    reason: 'SettingsPage should shrink into route shell, hooks, and workspaces.',
  },
  {
    path: 'apps/miniapp/src/styles/lazy-pages.css',
    maxLines: 13000,
    targetLines: 12000,
    reason: 'Route/component styles should leave the compatibility bundle over time.',
  },
  {
    path: 'packages/contracts/src/core.ts',
    maxLines: 3445,
    targetLines: 3400,
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
      `Target by ${targetDate}: ${guard.targetLines} lines or fewer.`,
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
