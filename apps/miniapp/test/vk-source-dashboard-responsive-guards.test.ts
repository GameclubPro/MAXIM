import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardSource = readFileSync(
  new URL('../src/components/vk-parsing/source-dashboard.tsx', import.meta.url),
  'utf8',
);
const dashboardCss = readFileSync(new URL('../src/styles/vk-parsing.css', import.meta.url), 'utf8');
const captureSource = readFileSync(
  new URL('../../../scripts/capture-miniapp-preview.mjs', import.meta.url),
  'utf8',
);

test('VK source summary keeps run mode and operational metrics in separate groups', () => {
  assert.match(dashboardSource, /className="vk-source-card__summary-row"/u);
  assert.match(dashboardSource, /<SourceModeControl[\s\S]*?className="vk-source-card__metrics"/u);
  assert.match(dashboardSource, /aria-label="Сводка источника"/u);
  assert.equal(dashboardSource.match(/<small>(Входящие|Очередь|Ошибки)<\/small>/gu)?.length, 3);
});

test('VK source cards stack their summary by card width with a mobile fallback', () => {
  assert.match(
    dashboardCss,
    /\.vk-source-card \{[\s\S]*?container-name: vk-source-card;[\s\S]*?container-type: inline-size;/u,
  );
  assert.match(
    dashboardCss,
    /@container vk-source-card \(max-width: 430px\) \{[\s\S]*?\.vk-source-card__summary-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    dashboardCss,
    /@media \(max-width: 520px\) \{[\s\S]*?\.vk-source-card__summary-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
  );
  assert.match(
    dashboardCss,
    /:is\(\.vk-autopost-mode, \.vk-source-mode-control\) button \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/u,
  );
});

test('strict visual capture rejects intersecting or clipped VK source summaries', () => {
  assert.match(captureSource, /await assertVkSourceSummariesSeparated\(page, scenario\);/u);
  assert.match(captureSource, /async function assertVkSourceSummariesSeparated/u);
  assert.match(captureSource, /mode and metrics overlap/u);
  assert.match(captureSource, /summary controls overlap/u);
  assert.match(captureSource, /element\.scrollWidth > element\.clientWidth \+ 1/u);
});
