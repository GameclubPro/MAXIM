import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const workspaceDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(workspaceDir, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

// Measured April 7, 2026 builds were within 60-192 bytes of the old limits,
// which made harmless MAX-miniapp UI polish and VPS/Alpine gzip drift too brittle.
// Keep the guardrail strict, but give the startup path enough room for iterative design work.
const STARTUP_JS_BUDGET_GZIP = 108 * 1024 + 512;
// Settings remains lazy-loaded, but richer giveaway, rules, and broadcast editors,
// shared drilldown UI reuse, the compact required-subscription timer card,
// the per-day broadcast agenda sheet, and the compact managed-broadcast
// confirm flow, visual markdown preview rendering in compact broadcast
// cards and sheets, the calendar-first quick scheduling planner,
// the premium planner dock plus smart quick-time suggestions,
// the richer broadcast compose/feed shell,
// the chat-audience picker with current/selected/all targeting,
// broadcast test-to-self delivery, duplicate-to-compose actions,
// favorite-audience quick selection and local text template entry points,
// bidirectional stop-word preset actions and inline +/- parsing,
// the invitation access gate with editable bot notices,
// plus the new-chat/channel handoff loading state
// add a small amount of legitimate lazy-loaded logic.
const SETTINGS_JS_BUDGET_GZIP = 108 * 1024 + 11 * 1024;
// Startup CSS was effectively at the ceiling already, so widen it modestly instead of
// forcing cosmetic regressions into the home surface and shared mobile shell.
const STARTUP_CSS_BUDGET_GZIP = 42 * 1024;
const BUDGET_TOLERANCE_GZIP = 64;

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

const startupJsGzip = sumGzip(startupJs);
const startupCssGzip = sumGzip(startupCss);
const settingsJsGzip = sumGzip(settingsIncrementalJs);

assertBudget('Startup JS', startupJsGzip, STARTUP_JS_BUDGET_GZIP);
assertBudget('Startup CSS', startupCssGzip, STARTUP_CSS_BUDGET_GZIP);
assertBudget('Settings JS', settingsJsGzip, SETTINGS_JS_BUDGET_GZIP);

console.log(
  [
    `Startup JS: ${formatKb(startupJsGzip)} gzip`,
    `Startup CSS: ${formatKb(startupCssGzip)} gzip`,
    `Settings JS: ${formatKb(settingsJsGzip)} gzip`,
  ].join('\n'),
);
