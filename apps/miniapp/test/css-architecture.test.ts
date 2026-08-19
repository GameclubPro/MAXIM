import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  buildMiniappCssMetricBaseline,
  findMiniappCssArchitectureViolations,
} from '../scripts/css-architecture.mjs';

const componentsCss = readFileSync(
  new URL('../src/styles/components.css', import.meta.url),
  'utf8',
);

function whiteContrastRatio(background: string): number {
  const channels = background
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  assert.ok(channels && channels.length === 3);

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const backgroundLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return 1.05 / (backgroundLuminance + 0.05);
}

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

test('loads the global layer order before modules that can import layered CSS', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');

  assert.match(source, /^import ['"]\.\/styles\.css['"];\n/u);
});

test('accent button gradient keeps white text at AA contrast', () => {
  const rule = /\.button--accent \{[\s\S]*?color: #fff;[\s\S]*?linear-gradient\(145deg, (#[0-9a-f]{6}), (#[0-9a-f]{6})\);/u.exec(
    componentsCss,
  );
  assert.ok(rule);

  assert.ok(whiteContrastRatio(rule[1]) >= 4.5);
  assert.ok(whiteContrastRatio(rule[2]) >= 4.5);
});
