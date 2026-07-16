import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const tokensCss = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const dashboardEventsCss = readFileSync(
  new URL('../src/styles/dashboard-events.css', import.meta.url),
  'utf8',
);
const channelStatsExecutiveCss = readFileSync(
  new URL('../src/styles/channel-stats-executive.css', import.meta.url),
  'utf8',
);

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/gu)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);
  assert.ok(channels && channels.length === 3);

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function readRootHexToken(name: string): string {
  const rootStart = tokensCss.indexOf(':root {');
  const rootEnd = tokensCss.indexOf('\n}', rootStart);
  const rootTokens = tokensCss.slice(rootStart, rootEnd);
  const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'u').exec(rootTokens);
  assert.ok(match, `Missing root token --${name}`);
  return match[1];
}

test('important favorite token clears AA contrast in light theme without changing dark token', () => {
  const foreground = readRootHexToken('favorite-important-text');
  const background = readRootHexToken('favorite-important-bg');

  assert.ok(contrastRatio(foreground, background) > 4.5);
  assert.match(
    tokensCss,
    /html\[data-max-theme='dark'\] \{\s*--favorite-important-text: #9a6200;\s*\}/u,
  );
  assert.match(
    tokensCss,
    /html:not\(\[data-max-theme\]\) \{\s*--favorite-important-text: #9a6200;/u,
  );
});

test('statistics interaction targets win over compact route rules', () => {
  const dashboardTargets = dashboardEventsCss.slice(
    dashboardEventsCss.lastIndexOf('body.events-page-open .logs-violation-item__quick-button,'),
  );

  assert.match(
    dashboardTargets,
    /\.logs-violation-item__quick-button,[\s\S]*?\.logs-violation-item__apply-button,[\s\S]*?\.membership-feed--immersive[\s\S]*?\.membership-feed__filters[\s\S]*?\.segmented-control__item \{\s*min-height: 44px;/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-insights__sticky-header \.compact-page-header__back \{\s*width: 44px;\s*min-width: 44px;\s*height: 44px;/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-events-section \.channel-insights__range \.segmented-control__item \{\s*min-height: 44px;/u,
  );
});

test('compact channel KPI cards remain a two-column grid through 380px', () => {
  const mobileStart = channelStatsExecutiveCss.lastIndexOf('@media (max-width: 380px)');
  const mobileEnd = channelStatsExecutiveCss.indexOf(
    '.channel-insights__sticky-header',
    mobileStart,
  );
  const mobileRules = channelStatsExecutiveCss.slice(mobileStart, mobileEnd);

  assert.ok(mobileStart >= 0);
  assert.ok(mobileEnd > mobileStart);
  assert.match(
    mobileRules,
    /\.channel-insights__summary-metrics--compact,\s*\.design-preview__device-screen \.channel-insights__summary-metrics--compact \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u,
  );
  assert.doesNotMatch(mobileRules, /grid-template-columns: minmax\(0, 1fr\)/u);
});

test('daily details keep a visible rotating disclosure and keyboard focus', () => {
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-summary-table-card > summary::after \{[\s\S]*?border-right: 2px solid currentColor;[\s\S]*?transform: rotate\(45deg\);/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-summary-table-card\[open\] > summary::after \{\s*transform: rotate\(225deg\);/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-summary-table-card > summary:focus-visible \{\s*outline: 2px solid var\(--app-focus-ring\);/u,
  );
});

test('events appbar heading and linked top posts stay readable on narrow screens', () => {
  assert.match(
    dashboardEventsCss,
    /\.events-stage__appbar-copy strong,\s*\.events-stage__appbar-title \{\s*margin: 0;/u,
  );
  assert.match(
    dashboardEventsCss,
    /html\[data-max-theme='dark'\] \.events-stage__appbar-title,/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-posts-chart__row-head \{\s*grid-template-columns: auto minmax\(0, 1fr\) auto;\s*min-width: 0;/u,
  );
  assert.match(
    channelStatsExecutiveCss,
    /\.channel-posts-chart__title \{\s*min-width: 0;\s*overflow-wrap: anywhere;\s*white-space: normal;/u,
  );
  assert.match(channelStatsExecutiveCss, /\.channel-posts-chart__row--linked \{/u);
  assert.match(channelStatsExecutiveCss, /\.channel-posts-chart__external-icon \{/u);
});
