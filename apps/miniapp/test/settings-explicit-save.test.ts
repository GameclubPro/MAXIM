import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const settingsPageSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const publisherModulesSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const settingsSectionToggleSource = readFileSync(
  new URL('../src/components/ui/settings-section-toggle.tsx', import.meta.url),
  'utf8',
);
const settingsOverviewFilterSource = readFileSync(
  new URL('../src/lib/settings-overview-filter.ts', import.meta.url),
  'utf8',
);
const managedGiveawaySource = readFileSync(
  new URL('../src/components/managed-giveaway-card.tsx', import.meta.url),
  'utf8',
);
const settingsDrilldownSource = readFileSync(
  new URL('../src/components/ui/settings-drilldown-panel.tsx', import.meta.url),
  'utf8',
);
const speechStyleSource = readFileSync(
  new URL('../src/pages/settings/settings-speech-style-panel.tsx', import.meta.url),
  'utf8',
);

test('chat comment settings belong to Publik instead of Major settings', () => {
  assert.doesNotMatch(settingsPageSource, /handleSaveComments|mutateCommentsAsync/u);
  assert.match(publisherModulesSource, /chatComments: updatePublisherChatCommentSetting/u);
  assert.match(publisherModulesSource, /updatePublisherModules/u);
});

test('overview settings tiles expose context, current state, and navigation affordance', () => {
  const renderSource = settingsSectionToggleSource.slice(
    settingsSectionToggleSource.indexOf('export function SettingsSectionToggle'),
  );

  assert.match(renderSource, /const trimmedSummary = summary\?\.trim\(\) \?\? '';/u);
  assert.match(renderSource, /const trimmedStatus = status\?\.trim\(\) \?\? '';/u);
  assert.match(renderSource, /aria-label=\{title\}/u);
  assert.match(renderSource, /aria-describedby=\{descriptionIds \|\| undefined\}/u);
  assert.match(renderSource, /data-settings-search=\{searchText\}/u);
  assert.match(renderSource, /settings-section__icon-badge/u);
  assert.match(renderSource, /settings-section__title">\{title\}<\/span>/u);
  assert.match(
    renderSource,
    /id=\{summaryId\} className="settings-section__summary">[\s\S]*?\{trimmedSummary\}/u,
  );
  assert.match(renderSource, /settings-section__status-chip/u);
  assert.match(renderSource, /settings-section__chevron/u);
  assert.match(renderSource, /<NavArrowRight/u);
});

test('settings search includes visible metadata and domain aliases', () => {
  assert.match(settingsSectionToggleSource, /SETTINGS_SECTION_SEARCH_ALIASES/u);
  assert.match(
    settingsOverviewFilterSource,
    /querySelectorAll<HTMLElement>\('\[data-settings-search\]'\)/u,
  );
  assert.match(settingsOverviewFilterSource, /entry\.textContent/u);
});

test('rules reset uses the in-app confirmation sheet', () => {
  assert.doesNotMatch(settingsPageSource, /window\.confirm\(/u);
  assert.match(settingsPageSource, /id="rules-reset-confirmation"/u);
  assert.match(settingsPageSource, /onConfirm=\{confirmResetPublishedRules\}/u);
});

test('rules autosave keeps draft editors enabled so mobile keyboard focus survives', () => {
  assert.match(
    settingsPageSource,
    /const isRulesDraftEditingDisabled =\s*isPublishingRules \|\|\s*isResettingPublishedRules \|\|\s*updateRulesAttachMutation\.isPending;/u,
  );
  assert.match(
    settingsPageSource,
    /const isRulesBusy = isSavingRules \|\| isRulesDraftEditingDisabled;/u,
  );

  const rulesComposerSource = settingsPageSource.slice(
    settingsPageSource.indexOf(
      '<LazyBroadcastContentComposer',
      settingsPageSource.indexOf('rules-panel'),
    ),
    settingsPageSource.indexOf('</Suspense>', settingsPageSource.indexOf('rules-panel')),
  );
  assert.match(rulesComposerSource, /disabled=\{isRulesDraftEditingDisabled\}/u);
  assert.doesNotMatch(rulesComposerSource, /disabled=\{isRulesBusy\}/u);

  const rulesButtonsSheetStart = settingsPageSource.indexOf('<LazyBroadcastButtonsSheet');
  const rulesButtonsSheetSource = settingsPageSource.slice(
    rulesButtonsSheetStart,
    settingsPageSource.indexOf('/>', rulesButtonsSheetStart),
  );
  assert.match(rulesButtonsSheetSource, /disabled=\{isRulesDraftEditingDisabled\}/u);
});

test('giveaway editors can intercept parent panel close requests', () => {
  assert.match(managedGiveawaySource, /export type ManagedGiveawayCardHandle/u);
  assert.match(managedGiveawaySource, /useImperativeHandle\(/u);
  assert.match(managedGiveawaySource, /requestClose: \(\) =>/u);
  assert.match(
    managedGiveawaySource,
    /setPendingConfirmation\(\{ kind: 'discard-editor', origin: 'back', closePanel: true \}\)/u,
  );
  assert.match(managedGiveawaySource, /clearEditor\(\);[\s\S]*?onClosePanel\(\);/u);
  assert.match(
    managedGiveawaySource,
    /enabled: isEditingOpen && pendingConfirmation === null, priority: 640/u,
  );
});

test('manual night close wins over the disabled schedule status', () => {
  assert.match(
    settingsPageSource,
    /const nightCardStatus = nightForceCloseSummary\s*\? 'Закрыто'\s*: draft\?\.nightModeEnabled/u,
  );
});

test('speech style opens on the selected radio and supports arrow navigation', () => {
  assert.match(settingsDrilldownSource, /initialFocusRef \?\? panelRef/u);
  assert.match(speechStyleSource, /initialFocusRef=\{selectedOptionRef\}/u);
  assert.match(speechStyleSource, /tabIndex=\{selectedStyle === option\.value \? 0 : -1\}/u);
  assert.match(speechStyleSource, /resolveRadioGroupNavigationIndex\(/u);
});
