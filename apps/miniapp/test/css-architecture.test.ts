import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  buildMiniappCssMetricBaseline,
  findMiniappCssArchitectureViolations,
} from '../scripts/css-architecture.mjs';

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function fixture(): { root: string; baselinePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'maxim-css-guard-'));
  write(root, 'apps/miniapp/src/app.tsx', "import './a.css';\n");
  write(
    root,
    'apps/miniapp/src/a.css',
    '@layer routes { .a { color: var(--local); --local: #fff; } }\n',
  );
  const baselinePath = join(root, 'apps/miniapp/css-metrics-baseline.json');
  write(
    root,
    'apps/miniapp/css-metrics-baseline.json',
    JSON.stringify(buildMiniappCssMetricBaseline(root)),
  );
  return { root, baselinePath };
}

test('allows route-local token declarations and reports a new literal with its line', () => {
  const { root, baselinePath } = fixture();
  write(
    root,
    'apps/miniapp/src/a.css',
    '@layer routes {\n  .a { color: var(--local); --local: #fff; background: #000; }\n}\n',
  );
  const violations = findMiniappCssArchitectureViolations(root, baselinePath);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /a\.css:2:.*raw color.*background/u);
});

test('prevents moving literal debt between files', () => {
  const { root, baselinePath } = fixture();
  write(root, 'apps/miniapp/src/b.css', '@layer routes { .b { color: #fff; } }\n');
  const violations = findMiniappCssArchitectureViolations(root, baselinePath);
  assert.match(violations.join('\n'), /b\.css:1:.*raw color/u);
});

test('requires directly imported CSS to have one explicit layer wrapper', () => {
  const { root, baselinePath } = fixture();
  write(root, 'apps/miniapp/src/a.css', '.a { color: var(--local); }\n');
  const violations = findMiniappCssArchitectureViolations(root, baselinePath);
  assert.match(violations.join('\n'), /entire file must be wrapped in one @layer block/u);
});
