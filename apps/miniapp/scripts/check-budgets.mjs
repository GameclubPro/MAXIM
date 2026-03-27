import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const workspaceDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(workspaceDir, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

const STARTUP_JS_BUDGET_GZIP = 100 * 1024;
// Small cross-environment headroom for gzip drift between local and Docker builds.
const SETTINGS_JS_BUDGET_GZIP = 90 * 1024 + 1536;
const STARTUP_CSS_BUDGET_GZIP = Math.round(35 * 1024) + 960;
const BUDGET_TOLERANCE_GZIP = 64;

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

function findManifestKey(suffix) {
  const key = Object.keys(manifest).find((candidate) => candidate.endsWith(suffix));
  if (!key) {
    throw new Error(`Manifest entry not found for ${suffix}`);
  }
  return key;
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
