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

test('expanded limit labels and values use the current workspace palette', () => {
  const ruleFor = (suffix: string) => {
    let result: Record<string, string> = {};
    root.walkRules((rule) => {
      if (rule.selector !== `body[data-miniapp-profile='moderation'] ${suffix}`) return;
      result = Object.fromEntries(
        rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
      );
    });
    return result;
  };
  const label = ruleFor('.settings-native-toggle__title--sub');
  assert.equal(label.background, 'transparent');
  assert.equal(label.color, 'var(--major-muted)');
  assert.equal(label['text-transform'], 'none');
  const thumb = ruleFor('.settings-native-switch .toggle-switch__thumb');
  assert.equal(thumb.background, 'var(--major-muted)');
  const slider = ruleFor('.settings-length-limit__slider');
  assert.equal(slider['min-height'], '44px');
  assert.equal(slider['accent-color'], 'var(--major-accent)');
  assert.equal(
    ruleFor('.settings-drilldown .field--error .field__hint').color,
    'var(--major-danger)',
  );
  let valueChecked = false;
  root.walkRules((rule) => {
    if (!rule.selector.includes('.settings-length-limit__value')) return;
    const properties = Object.fromEntries(
      rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
    );
    assert.equal(properties.background, 'var(--major-subtle)');
    assert.equal(properties.color, 'var(--major-ink)');
    assert.equal(properties['font-variant-numeric'], 'tabular-nums');
    valueChecked = true;
  });
  assert.ok(valueChecked);
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

test('settings summaries remain visible and help fits the measured visible area', () => {
  const declarationsFor = (selector: string) => {
    const values = new Map<string, string>();
    root.walkRules((rule) => {
      if (!rule.selectors.includes(selector)) return;
      rule.walkDecls((declaration) => {
        values.set(declaration.prop, declaration.value);
      });
    });
    return values;
  };
  const scope = "body[data-miniapp-profile='moderation']";
  const summary = declarationsFor(`${scope} .settings-section__summary`);
  assert.equal(summary.get('position'), 'static');
  assert.equal(summary.get('max-width'), '100%');
  assert.equal(summary.get('white-space'), 'normal');
  assert.equal(summary.get('overflow'), 'visible');
  const hint = declarationsFor(`${scope} .channel-settings-hint-popover`);
  assert.equal(hint.get('max-height'), 'var(--hint-popover-max-height, 280px)');
  assert.equal(hint.get('overflow-y'), 'auto');
  assert.equal(declarationsFor(`${scope} .settings-info-button`).get('min-height'), '44px');
});
