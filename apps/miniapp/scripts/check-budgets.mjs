import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  collectManifestAssets,
  differenceAssets,
  rankContributors,
  resolveBudgetLimit,
  validateBudgetConfig,
  validateRouteBudgetCoverage,
} from './budget-utils.mjs';

const workspaceDir = path.resolve(import.meta.dirname, '..');
const distDir = path.join(workspaceDir, 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');
const configPath = path.join(workspaceDir, 'route-budgets.json');

const manifest = readJson(manifestPath);
const config = readJson(configPath);
validateBudgetConfig(config);
const coveredRouteEntries = validateRouteBudgetCoverage(manifest, config);

const budgetById = new Map(config.budgets.map((budget) => [budget.id, budget]));
const rawAssetsByBudget = new Map();
const gzipSizeCache = new Map();

function rawAssetsForBudget(budget) {
  const cached = rawAssetsByBudget.get(budget.id);
  if (cached) {
    return cached;
  }
  const entryKeys = budget.entries.map(resolveManifestEntry);
  const assets = collectManifestAssets(manifest, entryKeys);
  rawAssetsByBudget.set(budget.id, assets);
  return assets;
}

function measuredAssetsForBudget(budget) {
  const assets = rawAssetsForBudget(budget);
  if (!budget.baseline) {
    return assets;
  }
  return differenceAssets(assets, rawAssetsForBudget(budgetById.get(budget.baseline)));
}

function resolveManifestEntry(reference) {
  if (manifest[reference]) {
    return reference;
  }

  const baseName = path.parse(reference).name;
  const candidate = Object.entries(manifest).find(
    ([entryKey, chunk]) =>
      entryKey.endsWith(reference) ||
      chunk?.name === baseName ||
      chunk?.file?.includes(`/${baseName}-`),
  )?.[0];
  if (!candidate) {
    throw new Error(`Manifest entry not found for ${reference}`);
  }
  return candidate;
}

function gzipSize(relativePath) {
  const cached = gzipSizeCache.get(relativePath);
  if (cached != null) {
    return cached;
  }
  const size = gzipSync(readFileSync(path.join(distDir, relativePath))).length;
  gzipSizeCache.set(relativePath, size);
  return size;
}

function sumGzip(files) {
  return [...files].reduce((total, file) => total + gzipSize(file), 0);
}

function formatKb(value) {
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatContributors(contributors) {
  if (contributors.length === 0) {
    return 'none';
  }
  return contributors
    .map(({ file, gzipBytes }) => `${path.basename(file)} ${formatKb(gzipBytes)}`)
    .join(', ');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

const failures = [];
console.log(`Route budget coverage: ${coveredRouteEntries.length} manifest entries`);

for (const budget of config.budgets) {
  const assets = measuredAssetsForBudget(budget);
  for (const asset of ['js', 'css']) {
    const limit = resolveBudgetLimit(budget, asset);
    if (limit == null) {
      continue;
    }
    const actual = sumGzip(assets[asset]);
    const contributors = rankContributors(assets[asset], gzipSize);
    const assetLabel = asset.toUpperCase();
    console.log(`${budget.label} ${assetLabel}: ${formatKb(actual)} / ${formatKb(limit)} gzip`);
    console.log(`  top ${assetLabel}: ${formatContributors(contributors)}`);
    if (actual > limit + config.toleranceGzipBytes) {
      failures.push(
        `${budget.label} ${assetLabel}: ${formatKb(actual)} gzip > ${formatKb(limit)} gzip`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Mini app route budgets exceeded:\n- ${failures.join('\n- ')}`);
}
