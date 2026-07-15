import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);

test('comments remain a local draft until the explicit save action', () => {
  assert.doesNotMatch(settingsPageSource, /saveCommentsMutation\.mutate\(payload\)/u);
  assert.match(
    settingsPageSource,
    /async function handleSaveComments\(\)[\s\S]*?await mutateCommentsAsync\(payload\)/u,
  );
});

test('overview settings tiles render only an icon and title', () => {
  const renderSource = settingsSectionToggleSource.slice(
    settingsSectionToggleSource.indexOf('export function SettingsSectionToggle'),
  );

  assert.match(renderSource, /aria-label=\{title\}/u);
  assert.match(renderSource, /settings-section__icon-badge/u);
  assert.match(renderSource, /<h3>\{title\}<\/h3>/u);
  assert.doesNotMatch(renderSource, /settings-section__status-chip/u);
  assert.doesNotMatch(renderSource, /settings-section__chevron/u);
  assert.doesNotMatch(renderSource, /trimmedSummary|trimmedStatus/u);
});
