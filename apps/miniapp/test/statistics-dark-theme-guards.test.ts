import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dashboardEventsCss = readFileSync(
  new URL('../src/styles/dashboard-events.css', import.meta.url),
  'utf8',
);
const channelStatsExecutiveCss = readFileSync(
  new URL('../src/styles/channel-stats-executive.css', import.meta.url),
  'utf8',
);
const statisticsExperienceCss = readFileSync(
  new URL('../src/styles/statistics-experience.css', import.meta.url),
  'utf8',
);
const channelStatsPageSource = readFileSync(
  new URL('../src/pages/channel-stats-page.tsx', import.meta.url),
  'utf8',
);

test('chat activity dashboard keeps its dark loading ledger on semantic surfaces', () => {
  const darkOverrides = dashboardEventsCss.slice(
    dashboardEventsCss.indexOf("html[data-max-theme='dark'] body.events-page-open"),
  );

  assert.match(
    darkOverrides,
    /\.events-dashboard__activity-ledger \{\s*border-color: var\(--border-subtle\);\s*background: var\(--surface-card-muted\);/u,
  );
  assert.match(
    darkOverrides,
    /\.events-dashboard__metric \+ \.events-dashboard__metric,[\s\S]*?\.events-dashboard__flow-card--left \{\s*border-color: var\(--border-subtle\);/u,
  );
  assert.match(
    darkOverrides,
    /\.events-dashboard__flow-bar:not\(\.events-dashboard__flow-bar--loading\) \{\s*background: var\(--border-strong\);/u,
  );
  assert.match(
    darkOverrides,
    /\.event-feed-item__toggle \{\s*border-color: var\(--border-strong\);\s*background: var\(--surface-card-muted\);\s*color: var\(--text-secondary\);/u,
  );
  assert.match(darkOverrides, /\.spammer-diagnostics__hero::before \{\s*opacity: 0;/u);
});

test('chat activity dashboard restores semantic KPI colors after broad dark rules', () => {
  const broadStrongRule = dashboardEventsCss.indexOf(
    "html[data-max-theme='dark'] .events-dashboard__metric strong,",
  );
  const finalSemanticRules = dashboardEventsCss.lastIndexOf(
    "html[data-max-theme='dark'] .events-dashboard__metric--success strong,",
  );

  assert.ok(broadStrongRule >= 0);
  assert.ok(finalSemanticRules > broadStrongRule);

  const finalOverrides = dashboardEventsCss.slice(finalSemanticRules);
  assert.match(
    finalOverrides,
    /\.events-dashboard__metric--success strong,[\s\S]*?\.events-dashboard__activity-balance--success strong,[\s\S]*?\.events-dashboard__flow-card--joined strong \{\s*color: var\(--success\);/u,
  );
  assert.match(
    finalOverrides,
    /\.events-dashboard__metric--warning strong,[\s\S]*?\.events-dashboard__flow-card--left strong \{\s*color: var\(--warning\);/u,
  );
  assert.match(
    finalOverrides,
    /\.events-dashboard__metric--danger strong,[\s\S]*?\.events-dashboard__activity-balance--danger strong \{\s*color: var\(--danger\);/u,
  );
});

test('channel event dark overrides keep their semantic final-layer import order', () => {
  const baseImport = channelStatsPageSource.indexOf("import '../styles/channel-stats.css'");
  const polishImport = channelStatsPageSource.indexOf(
    "import '../styles/channel-stats-route-polish.css'",
  );
  const executiveImport = channelStatsPageSource.indexOf(
    "import '../styles/channel-stats-executive.css'",
  );
  const experienceImport = channelStatsPageSource.indexOf(
    "import '../styles/statistics-experience.css'",
  );

  assert.ok(baseImport >= 0);
  assert.ok(polishImport > baseImport);
  assert.ok(executiveImport > polishImport);
  assert.ok(experienceImport > executiveImport);

  const marker = '/* Page-layer overrides must follow the light channel-events rules';
  const start = channelStatsExecutiveCss.indexOf(marker);
  const end = channelStatsExecutiveCss.indexOf('@media (max-width: 380px)', start);
  const darkOverrides = channelStatsExecutiveCss.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);

  for (const selector of [
    '.membership-feed__toolbar',
    '.membership-feed__filters',
    '.membership-feed__group-list',
    '.membership-feed__day',
    '.membership-feed__card',
    '.membership-feed__avatar',
    '.membership-feed__name-link',
    '.membership-feed__description',
    '.membership-feed__day-pill--joined',
    '.membership-feed__day-pill--left',
    '.membership-feed__item',
    '.membership-feed__rail::after',
    '.membership-feed__status',
    '.channel-events-section__metric strong',
  ]) {
    assert.ok(
      darkOverrides.includes(selector),
      `Missing dark channel events selector: ${selector}`,
    );
  }

  assert.match(darkOverrides, /background: var\(--surface-card\);/u);
  assert.match(darkOverrides, /background: var\(--surface-card-muted\);/u);
  assert.match(darkOverrides, /border-color: var\(--border-subtle\);/u);
  assert.match(darkOverrides, /color: var\(--text-primary\);/u);
  assert.match(darkOverrides, /color: var\(--text-secondary\);/u);
  assert.match(darkOverrides, /color: var\(--success\);/u);
  assert.match(darkOverrides, /color: var\(--danger\);/u);
  assert.doesNotMatch(darkOverrides, /rgba\(|#[\da-f]{3,8}\b/iu);
  assert.match(
    statisticsExperienceCss,
    /html\[data-max-theme='dark'\][\s\S]*?\.channel-insights__section-tabs[\s\S]*?background: var\(--accent\);[\s\S]*?color: var\(--color-surface\);/u,
  );
});

test('channel compact metrics keep semantic colors after the broad dark value rule', () => {
  const broadStrongRule = channelStatsExecutiveCss.indexOf(
    "html[data-max-theme='dark'] .channel-summary-card--compact > strong,",
  );
  const positiveRule = channelStatsExecutiveCss.lastIndexOf(
    "html[data-max-theme='dark'] .channel-summary-card--compact > strong.is-positive",
  );
  const negativeRule = channelStatsExecutiveCss.lastIndexOf(
    "html[data-max-theme='dark'] .channel-summary-card--compact > strong.is-negative",
  );

  assert.ok(broadStrongRule >= 0);
  assert.ok(positiveRule > broadStrongRule);
  assert.ok(negativeRule > positiveRule);
  assert.match(
    channelStatsExecutiveCss.slice(positiveRule),
    /strong\.is-positive \{\s*color: var\(--success\);\s*\}[\s\S]*?strong\.is-negative \{\s*color: var\(--danger\);/u,
  );
});

test('participant action buttons keep semantic contrast after settings CSS is bundled', () => {
  assert.match(
    statisticsExperienceCss,
    /html\[data-max-theme='dark'\][\s\S]*?\.participant-sheet[\s\S]*?\.participant-sheet__row-actions[\s\S]*?\.button--accent \{[\s\S]*?background: var\(--accent\);[\s\S]*?color: var\(--color-surface\);/u,
  );
  assert.match(
    statisticsExperienceCss,
    /html\[data-max-theme='dark'\][\s\S]*?\.participant-sheet[\s\S]*?\.participant-sheet__row-actions[\s\S]*?\.button--ghost \{[\s\S]*?background: var\(--surface-card\);[\s\S]*?color: var\(--text-primary\);/u,
  );
});
