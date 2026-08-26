import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  collectManifestAssets,
  differenceAssets,
  rankContributors,
  resolveBudgetLimit,
  validateBudgetConfig,
  validateRouteBudgetCoverage,
} from '../scripts/budget-utils.mjs';

const routeBudgets = JSON.parse(
  readFileSync(new URL('../route-budgets.json', import.meta.url), 'utf8'),
);

test('route budget config covers new route CSS surfaces', () => {
  validateBudgetConfig(routeBudgets);
  const budgetById = new Map(
    routeBudgets.budgets.map((budget: { id: string }) => [budget.id, budget]),
  );

  for (const id of ['publications', 'publisher-entities', 'events', 'suggest', 'legal', 'stats']) {
    const budget = budgetById.get(id) as { limits?: { cssGzipBytes?: number } } | undefined;
    assert.ok(budget?.limits?.cssGzipBytes, `${id} must have a CSS budget`);
  }
});

test('manifest asset collection deduplicates transitive chunks and supports baselines', () => {
  const manifest = {
    'index.html': {
      file: 'assets/index.js',
      css: ['assets/index.css'],
      imports: ['_shared.js'],
    },
    '_shared.js': { file: 'assets/shared.js', css: ['assets/shared.css'] },
    'src/pages/chats-page.tsx': {
      file: 'assets/chats.js',
      imports: ['index.html', '_shared.js'],
    },
    'src/pages/events-page.tsx': {
      file: 'assets/events.js',
      css: ['assets/events.css'],
      imports: ['index.html', '_shared.js'],
    },
  };
  const startup = collectManifestAssets(manifest, ['index.html', 'src/pages/chats-page.tsx']);
  const events = collectManifestAssets(manifest, ['src/pages/events-page.tsx']);
  const incremental = differenceAssets(events, startup);

  assert.deepEqual([...startup.js].sort(), [
    'assets/chats.js',
    'assets/index.js',
    'assets/shared.js',
  ]);
  assert.deepEqual([...incremental.js], ['assets/events.js']);
  assert.deepEqual([...incremental.css], ['assets/events.css']);
});

test('route coverage fails when a dynamic page manifest entry has no budget', () => {
  const manifest = {
    'src/pages/chats-page.tsx': { isDynamicEntry: true },
    'src/pages/events-page.tsx': { isDynamicEntry: true },
    'src/pages/home-entity-sheets.tsx': { isDynamicEntry: true },
  };
  const config = {
    manifestRouteEntryPattern: '^src/pages/[^/]+-page\\.tsx$',
    budgets: [{ entries: ['src/pages/chats-page.tsx'] }],
  };

  assert.throws(
    () => validateRouteBudgetCoverage(manifest, config),
    /src\/pages\/events-page\.tsx/u,
  );
});

test('budget allowances and top contributors are deterministic', () => {
  const budget = {
    limits: { jsGzipBytes: 1_000 },
    allowances: [
      {
        asset: 'js',
        bytes: 512,
        when: { env: 'VITE_API_BASE', matches: '^https?://' },
      },
      {
        asset: 'js',
        bytes: 128,
        when: { env: 'VITE_ROUTER_MODE', equals: 'hash' },
      },
    ],
  };
  assert.equal(resolveBudgetLimit(budget, 'js', {}), 1_000);
  assert.equal(
    resolveBudgetLimit(budget, 'js', {
      VITE_API_BASE: 'https://major-maksimov.ru/api/v1',
      VITE_ROUTER_MODE: 'hash',
    }),
    1_640,
  );
  assert.deepEqual(
    rankContributors(new Set(['small.js', 'large.js', 'medium.js']), (file) => file.length),
    [
      { file: 'medium.js', gzipBytes: 9 },
      { file: 'large.js', gzipBytes: 8 },
      { file: 'small.js', gzipBytes: 8 },
    ],
  );
});
