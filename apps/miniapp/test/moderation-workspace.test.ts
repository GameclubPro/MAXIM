import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const css = readFileSync(
  new URL('../src/styles/moderation-workspace.css', import.meta.url),
  'utf8',
);
const root = postcss.parse(css);
const shell = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');

test('moderation presentation is profile-scoped, including portal sheets', () => {
  assert.match(shell, /document\.body\.dataset\.miniappProfile = profile/u);
  assert.match(shell, /delete document\.body\.dataset\.miniappProfile/u);
  assert.equal(root.nodes.length, 1);
  assert.equal(root.nodes[0].type, 'atrule');
  assert.equal(root.nodes[0].name, 'layer');
  assert.equal(root.nodes[0].params, 'workspace');
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      assert.match(
        selector,
        /^(?:html\[data-max-theme='dark'\]\s+)?body\[data-miniapp-profile='moderation'\]/u,
      );
    }
  });
});

test('the workspace layer follows legacy routes without important declarations', () => {
  const entry = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.match(entry, /pages, workspace, motion/u);
  root.walkDecls((declaration) => {
    assert.equal(Boolean(declaration.important), false, declaration.toString());
    if (declaration.prop === 'font-size') {
      assert.doesNotMatch(declaration.value, /\b\d*(?:\.\d+)?v[wh]/u);
    }
    if (declaration.prop === 'letter-spacing') assert.equal(declaration.value, '0');
    if (declaration.prop === 'touch-action') assert.notEqual(declaration.value, 'none');
  });
});

test('both themes define the same essential semantic colors', () => {
  const palette = [
    'page',
    'surface',
    'subtle',
    'border',
    'ink',
    'muted',
    'accent',
    'danger',
    'positive',
  ];
  for (const selector of [
    "body[data-miniapp-profile='moderation']",
    "html[data-max-theme='dark'] body[data-miniapp-profile='moderation']",
  ]) {
    const rule = root.nodes[0].nodes.find(
      (node) => node.type === 'rule' && node.selector === selector,
    );
    assert.ok(rule);
    const names = rule.nodes.filter((node) => node.type === 'decl').map((node) => node.prop);
    for (const name of palette)
      assert.ok(names.includes(`--major-${name}`), `${selector}: ${name}`);
  }
});

test('channel period selection precedes the metrics it filters', () => {
  const source = readFileSync(
    new URL('../src/pages/channel-stats-page.tsx', import.meta.url),
    'utf8',
  );
  const toolbar = source.indexOf('className="channel-insights__overview-toolbar"');
  const metrics = source.indexOf('className="channel-insights__summary-metrics');
  assert.ok(toolbar > 0 && metrics > toolbar);
  assert.match(
    source.slice(toolbar, metrics),
    /formatPeriodRange\(stats\.period\.from, stats\.period\.to\)/u,
  );
  assert.match(source.slice(toolbar, metrics), /onRangeChange\(next as ChannelStatsRange\)/u);
});

test('mode labels stay complete and the visual audit checks their rendered text bounds', () => {
  assert.match(css, /-webkit-line-clamp: unset/u);
  const capture = readFileSync(
    new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
    'utf8',
  );
  assert.match(capture, /await assertCompactTextContained\(page, scenario\)/u);
  assert.match(capture, /\.channel-summary-table th, \.channel-summary-table td/u);
  assert.match(capture, /range\.getClientRects\(\)/u);
});

test('participant actions retain the real bottom safe area inside their scroll container', () => {
  assert.match(
    css,
    /\.participant-sheet \.settings-drilldown__body \{\s*padding-bottom: calc\(12px \+ env\(safe-area-inset-bottom, 0px\)\);/u,
  );
});
