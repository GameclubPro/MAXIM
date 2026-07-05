import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const workspaceDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(workspaceDir, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

// Measured April 7, 2026 builds were within 60-192 bytes of the old limits,
// which made harmless MAX-miniapp UI polish and VPS/Alpine gzip drift too brittle.
// Keep the guardrail strict, but give the startup path enough room for iterative design work
// and the large managed-entities home list virtualization needed for 100+ visible chats/channels.
// The six-type managed-entity favorites UI adds server-backed optimistic targeting and migration
// logic to the startup home surface; keep the added allowance narrow.
// Hash-router support keeps storage-hosted canary entry points usable; react-router keeps
// enough of that branch in the browser build that the measured startup cost is still paid.
const HASH_ROUTER_STARTUP_JS_ALLOWANCE_GZIP =
  process.env.VITE_ROUTER_MODE?.trim() === 'hash' ? 512 : 0;
// The standalone autopost hub is a top-level lazy route; only route registration is paid at startup.
const AUTOPOSTS_ROUTE_STARTUP_JS_ALLOWANCE_GZIP = 512;
// Keepalive writes must use the GET mutation tunnel synchronously on CDN-preferred hosts so
// page-leave profile handoff/stat updates preserve auth and survive GET-only front doors.
const KEEPALIVE_MUTATION_TUNNEL_STARTUP_JS_ALLOWANCE_GZIP = 512;
const STARTUP_JS_BUDGET_GZIP =
  113 * 1024 +
  HASH_ROUTER_STARTUP_JS_ALLOWANCE_GZIP +
  AUTOPOSTS_ROUTE_STARTUP_JS_ALLOWANCE_GZIP +
  KEEPALIVE_MUTATION_TUNNEL_STARTUP_JS_ALLOWANCE_GZIP;
// Settings remains lazy-loaded, but richer giveaway, rules, and broadcast editors,
// shared drilldown UI reuse, the compact required-subscription timer card,
// the per-day broadcast agenda sheet, and the compact managed-broadcast
// confirm flow, visual markdown preview rendering in compact broadcast
// cards and sheets, the calendar-first quick scheduling planner,
// the premium planner dock plus smart quick-time suggestions,
// the richer broadcast compose/feed shell,
// the chat-audience picker with current/selected/all targeting,
// broadcast test-to-self delivery, duplicate-to-compose actions,
// the three-tab broadcast workspace with calendar/archive filters,
// the publish review sheet,
// the sheet-based broadcast button editor,
// the apply-target confirmation sheet for settings fanout by favorite groups,
// the compact send-now/scheduled/cycle timing selector,
// favorite-audience quick selection and local text template entry points,
// bidirectional stop-word preset actions and inline +/- parsing,
// the new-chat/channel handoff loading state,
// plus 10-photo broadcast gallery preparation and preview
// plus rich paste parity for headings and code blocks in broadcast/suggestion previews
// plus target-aware broadcast calendar availability and named audience previews
// plus schema-level calendar/cycle compatibility guards for legacy broadcast drafts
// add a small amount of legitimate lazy-loaded logic.
// The standalone autopost hub reuses settings broadcast/autopost chunks, changing Vite factoring.
const AUTOPOSTS_SHARED_SETTINGS_JS_ALLOWANCE_GZIP = 1024;
// The standalone public suggestion route uses a focused dialog entry. Vite can factor the
// channel-dialog contract schemas into a shared chunk that settings already reaches through root
// contracts; keep the budget adjustment narrow while preserving the route split.
const SUGGEST_ROUTE_SHARED_SETTINGS_JS_ALLOWANCE_GZIP = 1024;
const SETTINGS_JS_BUDGET_GZIP =
  108 * 1024 +
  21 * 1024 +
  AUTOPOSTS_SHARED_SETTINGS_JS_ALLOWANCE_GZIP +
  SUGGEST_ROUTE_SHARED_SETTINGS_JS_ALLOWANCE_GZIP;
// Startup CSS was effectively at the ceiling already, so widen it modestly instead of
// forcing cosmetic regressions into the home surface and shared mobile shell.
const STARTUP_CSS_BUDGET_GZIP = 42 * 1024;
const SETTINGS_CSS_BUDGET_GZIP = 76 * 1024;
const CHANNEL_SETTINGS_JS_BUDGET_GZIP = 104 * 1024;
const CHANNEL_SETTINGS_CSS_BUDGET_GZIP = 76 * 1024;
// Top-level autopost contracts add a few shared schema bytes to the contracts/zod chunk
// that channel dialog already pays for.
const AUTOPOSTS_SHARED_CHANNEL_DIALOG_JS_ALLOWANCE_GZIP = 512;
const CHANNEL_DIALOG_JS_BUDGET_GZIP = 82 * 1024 + AUTOPOSTS_SHARED_CHANNEL_DIALOG_JS_ALLOWANCE_GZIP;
const CHANNEL_DIALOG_CSS_BUDGET_GZIP = 22 * 1024;
const CHANNEL_STATS_JS_BUDGET_GZIP = 26 * 1024;
const GIVEAWAY_JS_BUDGET_GZIP = 58 * 1024;
const VK_PARSING_CARD_JS_BUDGET_GZIP = 86 * 1024;
const BUDGET_TOLERANCE_GZIP = 320;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function findManifestKey(suffix) {
  const key = Object.keys(manifest).find((candidate) => candidate.endsWith(suffix));
  if (key) {
    return key;
  }

  const parsed = path.parse(suffix);
  const baseName = parsed.name;
  const dynamicEntryKey = Object.entries(manifest).find(([candidate, chunk]) => {
    if (!chunk || typeof chunk !== 'object') {
      return false;
    }

    return (
      chunk.name === baseName ||
      candidate.includes(`_${baseName}-`) ||
      chunk.file?.includes(`/${baseName}-`)
    );
  })?.[0];
  if (dynamicEntryKey) {
    return dynamicEntryKey;
  }

  throw new Error(`Manifest entry not found for ${suffix}`);
}

function collectAssets(entryKey, visited = new Set()) {
  if (visited.has(entryKey)) {
    return { js: new Set(), css: new Set() };
  }

  visited.add(entryKey);
  const chunk = manifest[entryKey];
  if (!chunk) {
    throw new Error(`Unknown manifest chunk: ${entryKey}`);
  }

  const js = new Set();
  const css = new Set(chunk.css ?? []);

  if (typeof chunk.file === 'string' && chunk.file.endsWith('.js')) {
    js.add(chunk.file);
  }

  for (const importKey of chunk.imports ?? []) {
    const imported = collectAssets(importKey, visited);
    for (const file of imported.js) {
      js.add(file);
    }
    for (const file of imported.css) {
      css.add(file);
    }
  }

  return { js, css };
}

function gzipSize(relativePath) {
  const file = readFileSync(path.join(distDir, relativePath));
  return gzipSync(file).length;
}

function sumGzip(files) {
  return Array.from(files).reduce((total, file) => total + gzipSize(file), 0);
}

function difference(source, baseline) {
  return new Set(Array.from(source).filter((item) => !baseline.has(item)));
}

function formatKb(value) {
  return `${(value / 1024).toFixed(1)} KB`;
}

function assertBudget(label, actual, budget) {
  if (actual > budget + BUDGET_TOLERANCE_GZIP) {
    throw new Error(`${label}: ${formatKb(actual)} gzip > ${formatKb(budget)} gzip`);
  }
}

const entryAssets = collectAssets('index.html');
const chatsAssets = collectAssets(findManifestKey('src/pages/chats-page.tsx'));
const startupJs = new Set([...entryAssets.js, ...chatsAssets.js]);
const startupCss = new Set([...entryAssets.css, ...chatsAssets.css]);

const settingsAssets = collectAssets(findManifestKey('src/pages/settings-page.tsx'));
const settingsIncrementalJs = difference(settingsAssets.js, startupJs);
const settingsIncrementalCss = difference(settingsAssets.css, startupCss);
const channelSettingsAssets = collectAssets(findManifestKey('src/pages/channel-settings-page.tsx'));
const channelSettingsIncrementalJs = difference(channelSettingsAssets.js, startupJs);
const channelSettingsIncrementalCss = difference(channelSettingsAssets.css, startupCss);
const channelDialogAssets = collectAssets(findManifestKey('src/pages/channel-dialog-page.tsx'));
const channelDialogIncrementalJs = difference(channelDialogAssets.js, startupJs);
const channelDialogIncrementalCss = difference(channelDialogAssets.css, startupCss);
const channelStatsAssets = collectAssets(findManifestKey('src/pages/channel-stats-page.tsx'));
const channelStatsIncrementalJs = difference(channelStatsAssets.js, startupJs);
const giveawayAssets = collectAssets(findManifestKey('src/pages/giveaway-page.tsx'));
const giveawayIncrementalJs = difference(giveawayAssets.js, startupJs);
const vkParsingCardAssets = collectAssets(findManifestKey('src/components/vk-parsing-card.tsx'));
const vkParsingCardIncrementalJs = difference(vkParsingCardAssets.js, startupJs);

const startupJsGzip = sumGzip(startupJs);
const startupCssGzip = sumGzip(startupCss);
const settingsJsGzip = sumGzip(settingsIncrementalJs);
const settingsCssGzip = sumGzip(settingsIncrementalCss);
const channelSettingsJsGzip = sumGzip(channelSettingsIncrementalJs);
const channelSettingsCssGzip = sumGzip(channelSettingsIncrementalCss);
const channelDialogJsGzip = sumGzip(channelDialogIncrementalJs);
const channelDialogCssGzip = sumGzip(channelDialogIncrementalCss);
const channelStatsJsGzip = sumGzip(channelStatsIncrementalJs);
const giveawayJsGzip = sumGzip(giveawayIncrementalJs);
const vkParsingCardJsGzip = sumGzip(vkParsingCardIncrementalJs);

assertBudget('Startup JS', startupJsGzip, STARTUP_JS_BUDGET_GZIP);
assertBudget('Startup CSS', startupCssGzip, STARTUP_CSS_BUDGET_GZIP);
assertBudget('Settings JS', settingsJsGzip, SETTINGS_JS_BUDGET_GZIP);
assertBudget('Settings CSS', settingsCssGzip, SETTINGS_CSS_BUDGET_GZIP);
assertBudget('Channel settings JS', channelSettingsJsGzip, CHANNEL_SETTINGS_JS_BUDGET_GZIP);
assertBudget('Channel settings CSS', channelSettingsCssGzip, CHANNEL_SETTINGS_CSS_BUDGET_GZIP);
assertBudget('Channel dialog JS', channelDialogJsGzip, CHANNEL_DIALOG_JS_BUDGET_GZIP);
assertBudget('Channel dialog CSS', channelDialogCssGzip, CHANNEL_DIALOG_CSS_BUDGET_GZIP);
assertBudget('Channel stats JS', channelStatsJsGzip, CHANNEL_STATS_JS_BUDGET_GZIP);
assertBudget('Giveaway JS', giveawayJsGzip, GIVEAWAY_JS_BUDGET_GZIP);
assertBudget('VK parsing card JS', vkParsingCardJsGzip, VK_PARSING_CARD_JS_BUDGET_GZIP);

console.log(
  [
    `Startup JS: ${formatKb(startupJsGzip)} gzip`,
    `Startup CSS: ${formatKb(startupCssGzip)} gzip`,
    `Settings JS: ${formatKb(settingsJsGzip)} gzip`,
    `Settings CSS: ${formatKb(settingsCssGzip)} gzip`,
    `Channel settings JS: ${formatKb(channelSettingsJsGzip)} gzip`,
    `Channel settings CSS: ${formatKb(channelSettingsCssGzip)} gzip`,
    `Channel dialog JS: ${formatKb(channelDialogJsGzip)} gzip`,
    `Channel dialog CSS: ${formatKb(channelDialogCssGzip)} gzip`,
    `Channel stats JS: ${formatKb(channelStatsJsGzip)} gzip`,
    `Giveaway JS: ${formatKb(giveawayJsGzip)} gzip`,
    `VK parsing card JS: ${formatKb(vkParsingCardJsGzip)} gzip`,
  ].join('\n'),
);
