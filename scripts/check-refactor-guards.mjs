import { dirname, relative, resolve } from 'node:path';
import { readdirSync, readFileSync, statSync } from 'node:fs';

const root = resolve(import.meta.dirname, '..');

const targetDate = '2026-06-26';

const guardedFiles = [
  {
    path: 'apps/api/src/admin/admin.service.legacy.ts',
    maxLines: 23000,
    targetLines: 23000,
    reason:
      'AdminService implementation is a legacy hotspot; managed entities, broadcasts, settings, and rules should keep moving to focused services.',
  },
  {
    path: 'apps/api/src/moderation/moderation.service.legacy.ts',
    maxLines: 18542,
    targetLines: 15500,
    reason:
      'ModerationService implementation is a legacy hotspot; explanation, access, global spammer, and night-mode helpers should keep moving to focused modules.',
  },
  {
    path: 'apps/api/src/moderation/private-control.service.legacy.ts',
    maxLines: 9570,
    targetLines: 9500,
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
    path: 'apps/miniapp/src/styles/settings-native-controls.css',
    maxLines: 380,
    targetLines: 300,
    reason:
      'Shared settings native controls should stay focused instead of becoming a route compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-home-compact.css',
    maxLines: 320,
    targetLines: 250,
    reason:
      'Compact settings home and channel card styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-home-route-polish.css',
    maxLines: 560,
    targetLines: 430,
    reason:
      'Settings home shell polish should stay route-owned instead of returning to broad settings route CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-rules-studio.css',
    maxLines: 270,
    targetLines: 220,
    reason:
      'Rules studio styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/broadcast-studio-base.css',
    maxLines: 1145,
    targetLines: 900,
    reason:
      'Broadcast studio base styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-policy-controls.css',
    maxLines: 320,
    targetLines: 250,
    reason:
      'Settings policy/control island styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-link-allowlist.css',
    maxLines: 520,
    targetLines: 420,
    reason:
      'Link allowlist styles should stay route-owned instead of returning to the lazy compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/pages/settings-page.css',
    maxLines: 420,
    targetLines: 330,
    reason:
      'Settings route-owned CSS should stay focused while legacy settings page markup is extracted.',
  },
  {
    path: 'apps/miniapp/src/pages/settings/settings-duplicate-stage.css',
    maxLines: 130,
    targetLines: 95,
    reason:
      'Duplicate moderation stage styles should stay with the settings duplicate panel owner.',
  },
  {
    path: 'apps/miniapp/src/components/ui/segmented-control.css',
    maxLines: 48,
    targetLines: 40,
    reason:
      'SegmentedControl base styles should stay component-owned while route-specific sizing stays scoped.',
  },
  {
    path: 'apps/miniapp/src/components/ui/toast.css',
    maxLines: 66,
    targetLines: 52,
    reason:
      'Toast portal styles should stay component-owned while route-specific placement overrides stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/managed-broadcast-history-card.css',
    maxLines: 242,
    targetLines: 190,
    reason:
      'ManagedBroadcastHistoryCard styles should stay component-owned while route density overrides stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/managed-broadcast-delivery-meter.css',
    maxLines: 76,
    targetLines: 60,
    reason:
      'ManagedBroadcastDeliveryMeter styles should stay component-owned instead of returning to broadcast route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/broadcast-schedule-planner.css',
    maxLines: 2065,
    targetLines: 1500,
    reason:
      'BroadcastSchedulePlanner base styles should stay component-owned instead of returning to lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/chat-onboarding-section.css',
    maxLines: 96,
    targetLines: 72,
    reason:
      'Chat onboarding empty-state styles should stay with the lazy-loaded onboarding component.',
  },
  {
    path: 'apps/miniapp/src/components/max-markdown-editor.css',
    maxLines: 114,
    targetLines: 90,
    reason:
      'MaxMarkdownEditor styles should stay component-owned and avoid leaking back into lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/max-rich-text-editor.css',
    maxLines: 148,
    targetLines: 115,
    reason:
      'MaxRichTextEditor base styles should stay component-owned and route overrides should stay scoped.',
  },
  {
    path: 'apps/miniapp/src/components/ui/action-confirm-sheet.css',
    maxLines: 190,
    targetLines: 150,
    reason:
      'ActionConfirmSheet is a portal component; its sheet styles should stay component-owned.',
  },
  {
    path: 'apps/miniapp/src/components/bot-speech-message-editor-sheet.css',
    maxLines: 320,
    targetLines: 260,
    reason:
      'Bot speech editor sheet styles should stay with the lazy-loaded sheet component.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-drilldown-core.css',
    maxLines: 1323,
    targetLines: 1100,
    reason:
      'Settings drilldown core CSS should own shell-scoped overrides without becoming another route dump.',
  },
  {
    path: 'apps/miniapp/src/styles/components.css',
    maxLines: 1520,
    targetLines: 1350,
    reason:
      'Startup shared styles should stay focused on primitives; route-specific home styles should move to route/component CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-duration-editor.css',
    maxLines: 198,
    targetLines: 160,
    reason:
      'Settings duration editor CSS should stay focused and avoid returning to the lazy route bundle.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/membership-activity-feed.css',
    maxLines: 600,
    targetLines: 520,
    reason:
      'Membership activity feed styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/chat-participants-roster.css',
    maxLines: 560,
    targetLines: 500,
    reason:
      'Chat participants roster styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/chat-participant-sheet.css',
    maxLines: 560,
    targetLines: 500,
    reason:
      'Chat participant sheet styles should stay component-owned after moving its base and responsive rules out of dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/dashboard/dashboard-hero.css',
    maxLines: 150,
    targetLines: 120,
    reason:
      'DashboardHero styles should stay component-owned instead of returning to dashboard-events.css.',
  },
  {
    path: 'apps/miniapp/src/components/required-subscription-source-picker.css',
    maxLines: 370,
    targetLines: 300,
    reason:
      'RequiredSubscriptionSourcePicker styles should stay component-owned instead of returning to managed-giveaway route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/broadcast-studio-header.css',
    maxLines: 165,
    targetLines: 130,
    reason:
      'BroadcastStudioChecklist styles should stay component-owned instead of returning to broadcast route CSS.',
  },
  {
    path: 'apps/miniapp/src/components/message-limits-blocked-word-presets.css',
    maxLines: 220,
    targetLines: 170,
    reason:
      'MessageLimitsBlockedWordPresets styles should stay component-owned instead of returning to lazy route CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-dialog-image-viewer.css',
    maxLines: 203,
    targetLines: 180,
    reason:
      'Channel dialog image viewer CSS should remain a focused route-owned lightbox slice.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-stats.css',
    maxLines: 3031,
    targetLines: 2400,
    reason:
      'Channel stats owner CSS should stay scoped and avoid becoming another compatibility bundle.',
  },
  {
    path: 'apps/miniapp/src/styles/settings-route-polish.css',
    maxLines: 4710,
    targetLines: 3300,
    reason:
      'Settings route polish should keep shrinking into scoped route sections and component-owned styles.',
  },
  {
    path: 'apps/miniapp/src/styles/broadcast-studio.css',
    maxLines: 5086,
    targetLines: 3660,
    reason:
      'Broadcast composer/planner/history styles should keep moving to component-owned CSS.',
  },
  {
    path: 'apps/miniapp/src/styles/dashboard-events.css',
    maxLines: 5112,
    targetLines: 3600,
    reason:
      'Dashboard feed, participant sheet, and stats primitives should keep moving to scoped component CSS; owner CSS may carry local bases removed from shared bundles.',
  },
  {
    path: 'apps/miniapp/src/styles/channel-dialog-comments.css',
    maxLines: 5478,
    targetLines: 4200,
    reason:
      'Channel dialog route CSS should stay scoped and continue shrinking into focused dialog components.',
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
const importStatementPattern =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu;
const typeOnlyImportStatementPattern = /^\s*(?:import|export)\s+type\b/u;
const productionSourcePathPattern =
  /^(?:apps|packages)\/[^/]+\/src\/(?!generated\/).*?\.(?:ts|tsx|js|mjs|cjs)$/u;
const testSourcePathPattern = /(?:^|\/)(?:test|__tests__)\/|(?:\.spec|\.test)\.[cm]?[tj]sx?$/u;

const allowedImportCycles = [
  {
    name: 'AdminService temporary legacy facade',
    paths: [
      'apps/api/src/admin/admin.service.ts',
      'apps/api/src/admin/admin.service.impl.ts',
      'apps/api/src/admin/admin.service.legacy.ts',
    ],
  },
  {
    name: 'ModerationService temporary legacy facade',
    paths: [
      'apps/api/src/moderation/moderation.service.ts',
      'apps/api/src/moderation/moderation.service.impl.ts',
      'apps/api/src/moderation/moderation.service.legacy.ts',
    ],
  },
  {
    name: 'PrivateControlService temporary legacy facade',
    paths: [
      'apps/api/src/moderation/private-control.service.ts',
      'apps/api/src/moderation/private-control.service.legacy.ts',
    ],
  },
  {
    name: 'SettingsPage temporary legacy facade',
    paths: [
      'apps/miniapp/src/pages/settings-page.tsx',
      'apps/miniapp/src/pages/settings-page.legacy.tsx',
    ],
  },
];

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

const miniappCssMetricGuards = [
  {
    name: 'hardcoded color references outside tokens.css',
    max: 6291,
    count: countMiniappCssHardcodedColorReferences,
    reason:
      'New colors should be introduced through semantic design tokens instead of component-local literals.',
  },
  {
    name: '!important declarations',
    max: 8,
    count: countMiniappCssImportantDeclarations,
    reason:
      'New cascade fixes should use layers, scopes, and tokens instead of adding specificity escapes.',
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

for (const violation of findImportCycleViolations(root)) {
  failed = true;
  console.error(
    [
      `Import cycle detected: ${violation.cycle.join(' -> ')}`,
      'Production modules should stay acyclic so extraction work can move code behind stable boundaries.',
      `Allowed temporary facade cycles: ${allowedImportCycles.map((cycle) => cycle.name).join(', ')}`,
    ].join('\n'),
  );
}

for (const violation of findMiniappDirectCssLayerViolations(root)) {
  failed = true;
  console.error(
    [
      `${violation.importer} imports ${violation.cssPath} without full CSS cascade-layer coverage.`,
      violation.reason,
      'Every miniapp CSS file imported directly from TS/TSX/JS must be fully wrapped in an @layer block.',
      'Keep globally imported base files routed through apps/miniapp/src/styles.css with @import ... layer(...).',
    ].join('\n'),
  );
}

for (const guard of miniappCssMetricGuards) {
  const actual = guard.count(root);
  if (actual <= guard.max) {
    continue;
  }

  failed = true;
  console.error(
    [
      `Miniapp CSS has ${actual} ${guard.name}, over the ${guard.max} refactor guard.`,
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

function findImportCycleViolations(directory) {
  const sourceFiles = walkSourceFiles(directory)
    .filter((filePath) => isProductionSourceFile(toRepoPath(filePath)))
    .map((filePath) => resolve(filePath));
  const sourceFileSet = new Set(sourceFiles);
  const graph = new Map(sourceFiles.map((filePath) => [filePath, []]));

  for (const filePath of sourceFiles) {
    const contents = readFileSync(filePath, 'utf8');
    for (const specifier of findRuntimeImportSpecifiers(contents)) {
      const resolvedImport = resolveLocalSourceImport(filePath, specifier, sourceFileSet);
      if (resolvedImport) {
        graph.get(filePath)?.push(resolvedImport);
      }
    }
  }

  const violations = [];
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const seenCycles = new Set();

  for (const filePath of sourceFiles) {
    visit(filePath);
  }

  return violations;

  function visit(filePath) {
    if (visited.has(filePath)) {
      return;
    }
    if (visiting.has(filePath)) {
      return;
    }

    visiting.add(filePath);
    stack.push(filePath);

    for (const dependency of graph.get(filePath) ?? []) {
      if (visiting.has(dependency)) {
        const startIndex = stack.indexOf(dependency);
        if (startIndex < 0) {
          continue;
        }

        const cycle = [...stack.slice(startIndex), dependency].map(toRepoPath);
        const cycleKey = canonicalizeCycle(cycle);
        if (seenCycles.has(cycleKey) || isAllowedImportCycle(cycle)) {
          continue;
        }

        seenCycles.add(cycleKey);
        violations.push({ cycle });
      } else if (!visited.has(dependency)) {
        visit(dependency);
      }
    }

    stack.pop();
    visiting.delete(filePath);
    visited.add(filePath);
  }
}

function findMiniappDirectCssLayerViolations(directory) {
  const miniappSourceRoot = resolve(directory, 'apps/miniapp/src');
  const violations = [];

  for (const filePath of walkSourceFiles(miniappSourceRoot)) {
    const contents = readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(importStatementPattern)) {
      const specifier = match[1] ?? match[2] ?? '';
      if (!specifier.startsWith('.') || !specifier.endsWith('.css')) {
        continue;
      }

      const cssPath = resolve(dirname(filePath), specifier);
      const cssContents = readFileSync(cssPath, 'utf8');
      if (toRepoPath(cssPath) === 'apps/miniapp/src/styles.css') {
        const entrypointViolationReason = getCssEntrypointViolationReason(cssContents);
        if (!entrypointViolationReason) {
          continue;
        }

        violations.push({
          importer: toRepoPath(filePath),
          cssPath: toRepoPath(cssPath),
          reason: entrypointViolationReason,
        });
        continue;
      }

      const layerViolationReason = getCssLayerViolationReason(cssContents);
      if (!layerViolationReason) {
        continue;
      }

      violations.push({
        importer: toRepoPath(filePath),
        cssPath: toRepoPath(cssPath),
        reason: layerViolationReason,
      });
    }
  }

  return violations;
}

function countMiniappCssHardcodedColorReferences(directory) {
  const cssFiles = walkFilesByExtension(resolve(directory, 'apps/miniapp/src'), new Set(['.css']));
  const colorPattern =
    /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bhwb\(|\bcolor-mix\(/gu;

  let count = 0;
  for (const filePath of cssFiles) {
    if (toRepoPath(filePath) === 'apps/miniapp/src/styles/tokens.css') {
      continue;
    }

    count += stripCssComments(readFileSync(filePath, 'utf8')).match(colorPattern)?.length ?? 0;
  }

  return count;
}

function countMiniappCssImportantDeclarations(directory) {
  const cssFiles = walkFilesByExtension(resolve(directory, 'apps/miniapp/src'), new Set(['.css']));
  let count = 0;

  for (const filePath of cssFiles) {
    count += stripCssComments(readFileSync(filePath, 'utf8')).match(/!important\b/gu)?.length ?? 0;
  }

  return count;
}

function getCssLayerViolationReason(contents) {
  const withoutComments = stripCssComments(contents);
  const trimmed = withoutComments.trim();
  if (!trimmed) {
    return null;
  }

  const importViolation = findUnlayeredCssImport(trimmed);
  if (importViolation) {
    return `CSS @import must include layer(...): ${importViolation}`;
  }

  if (!/^@layer\s+[-\w.]+(?:\s*,\s*[-\w.]+)*\s*\{/u.test(trimmed)) {
    return 'The file must start with a wrapping @layer <name> { ... } block.';
  }

  const endIndex = findMatchingBlockEnd(trimmed, trimmed.indexOf('{'));
  if (endIndex < 0) {
    return 'The opening @layer block is not balanced.';
  }

  const trailing = trimmed.slice(endIndex + 1).trim();
  if (trailing) {
    return 'Top-level CSS remains after the opening @layer block; keep the whole file inside the layer.';
  }

  return null;
}

function getCssEntrypointViolationReason(contents) {
  const withoutComments = stripCssComments(contents);
  const trimmed = withoutComments.trim();
  if (!trimmed) {
    return 'The global CSS entrypoint must declare cascade layers and import layered CSS files.';
  }

  const importViolation = findUnlayeredCssImport(trimmed);
  if (importViolation) {
    return `CSS @import must include layer(...): ${importViolation}`;
  }

  const withoutLayerList = trimmed.replace(
    /^@layer\s+[-\w.]+(?:\s*,\s*[-\w.]+)*\s*;\s*/u,
    '',
  );
  const withoutLayeredImports = withoutLayerList
    .replace(/@import\s+(?:url\()?['"][^'"]+\.css['"]\)?\s+layer\([-\w.]+\)\s*;\s*/gu, '')
    .trim();

  if (withoutLayeredImports) {
    return 'The global CSS entrypoint may only declare layer order and import CSS with layer(...).';
  }

  return null;
}

function findUnlayeredCssImport(contents) {
  const importPattern = /@import\s+(?:url\()?['"][^'"]+\.css['"]\)?[^;]*;/gu;
  for (const match of contents.matchAll(importPattern)) {
    if (!/\blayer\s*\(/u.test(match[0])) {
      return match[0];
    }
  }

  return null;
}

function findMatchingBlockEnd(contents, openBraceIndex) {
  let depth = 0;
  let quote = '';
  let escaped = false;

  for (let index = openBraceIndex; index < contents.length; index += 1) {
    const char = contents[index];

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = '';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripCssComments(contents) {
  return contents.replace(/\/\*[\s\S]*?\*\//gu, '');
}

function findRuntimeImportSpecifiers(contents) {
  const specifiers = [];
  for (const match of contents.matchAll(importStatementPattern)) {
    const statement = match[0];
    if (typeOnlyImportStatementPattern.test(statement)) {
      continue;
    }

    const specifier = match[1] ?? match[2] ?? '';
    if (specifier.startsWith('.')) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function resolveLocalSourceImport(fromFilePath, specifier, sourceFileSet) {
  const basePath = resolve(dirname(fromFilePath), specifier);
  for (const candidate of buildImportCandidates(basePath)) {
    if (sourceFileSet.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildImportCandidates(basePath) {
  const extensions = Array.from(sourceExtensions);
  return [
    basePath,
    ...extensions.map((extension) => `${basePath}${extension}`),
    ...extensions.map((extension) => resolve(basePath, `index${extension}`)),
  ].map((candidate) => resolve(candidate));
}

function canonicalizeCycle(cycle) {
  const uniqueCycle = cycle.slice(0, -1);
  const rotations = uniqueCycle.map((_, index) => [
    ...uniqueCycle.slice(index),
    ...uniqueCycle.slice(0, index),
  ]);
  rotations.sort((left, right) => left.join('\n').localeCompare(right.join('\n')));
  return rotations[0].join(' -> ');
}

function isAllowedImportCycle(cycle) {
  const cyclePaths = new Set(cycle);
  return allowedImportCycles.some((allowedCycle) =>
    allowedCycle.paths.every((filePath) => cyclePaths.has(filePath)),
  );
}

function isProductionSourceFile(repoPath) {
  return productionSourcePathPattern.test(repoPath) && !testSourcePathPattern.test(repoPath);
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

function walkFilesByExtension(directory, extensions) {
  const entries = readdirSync(directory);
  const files = [];

  for (const entry of entries) {
    const entryPath = resolve(directory, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      if (ignoredDirectoryNames.has(entry)) {
        continue;
      }
      files.push(...walkFilesByExtension(entryPath, extensions));
      continue;
    }

    if (stats.isFile() && extensions.has(readExtension(entry))) {
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
