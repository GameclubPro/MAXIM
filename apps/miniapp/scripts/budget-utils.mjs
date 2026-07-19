export function collectManifestAssets(manifest, entryKeys) {
  const assets = { js: new Set(), css: new Set() };
  const visited = new Set();

  for (const entryKey of entryKeys) {
    collectEntryAssets(manifest, entryKey, visited, assets);
  }
  return assets;
}

export function differenceAssets(source, baseline) {
  return {
    js: difference(source.js, baseline.js),
    css: difference(source.css, baseline.css),
  };
}

export function discoverManifestRouteEntries(manifest, pattern) {
  const routePattern = new RegExp(pattern, 'u');
  return Object.entries(manifest)
    .filter(
      ([entryKey, chunk]) =>
        routePattern.test(entryKey) && chunk && typeof chunk === 'object' && chunk.isDynamicEntry,
    )
    .map(([entryKey]) => entryKey)
    .sort();
}

export function validateRouteBudgetCoverage(manifest, config) {
  const discovered = discoverManifestRouteEntries(manifest, config.manifestRouteEntryPattern);
  const configured = new Set(
    config.budgets
      .filter((budget) => budget.coversRouteEntry !== false)
      .flatMap((budget) => budget.entries),
  );
  const missing = discovered.filter((entryKey) => !configured.has(entryKey));
  if (missing.length > 0) {
    throw new Error(`Route budgets missing manifest entries: ${missing.join(', ')}`);
  }
  return discovered;
}

export function resolveBudgetLimit(budget, asset, env = process.env) {
  const limitKey = asset === 'js' ? 'jsGzipBytes' : 'cssGzipBytes';
  const baseLimit = budget.limits?.[limitKey];
  if (!Number.isFinite(baseLimit)) {
    return null;
  }

  return (budget.allowances ?? [])
    .filter((allowance) => allowance.asset === asset && matchesCondition(allowance.when, env))
    .reduce((total, allowance) => total + allowance.bytes, baseLimit);
}

export function rankContributors(files, gzipSize, limit = 3) {
  return [...files]
    .map((file) => ({ file, gzipBytes: gzipSize(file) }))
    .sort((left, right) => right.gzipBytes - left.gzipBytes || left.file.localeCompare(right.file))
    .slice(0, limit);
}

export function validateBudgetConfig(config) {
  if (config.schemaVersion !== 1) {
    throw new Error(`Unsupported route budget schema version: ${config.schemaVersion}`);
  }
  if (!Array.isArray(config.budgets) || config.budgets.length === 0) {
    throw new Error('Route budget config must define at least one budget.');
  }

  const ids = new Set();
  for (const budget of config.budgets) {
    if (!budget.id || ids.has(budget.id)) {
      throw new Error(`Route budget id must be present and unique: ${budget.id ?? '<missing>'}`);
    }
    ids.add(budget.id);
    if (!Array.isArray(budget.entries) || budget.entries.length === 0) {
      throw new Error(`Route budget ${budget.id} must define manifest entries.`);
    }
    if (
      !Number.isFinite(budget.limits?.jsGzipBytes) &&
      !Number.isFinite(budget.limits?.cssGzipBytes)
    ) {
      throw new Error(`Route budget ${budget.id} must define a JS or CSS limit.`);
    }
  }

  for (const budget of config.budgets) {
    if (budget.baseline && !ids.has(budget.baseline)) {
      throw new Error(`Route budget ${budget.id} references unknown baseline ${budget.baseline}.`);
    }
  }
}

function collectEntryAssets(manifest, entryKey, visited, assets) {
  if (visited.has(entryKey)) {
    return;
  }
  visited.add(entryKey);

  const chunk = manifest[entryKey];
  if (!chunk) {
    throw new Error(`Manifest entry not found: ${entryKey}`);
  }
  if (typeof chunk.file === 'string' && chunk.file.endsWith('.js')) {
    assets.js.add(chunk.file);
  }
  for (const cssFile of chunk.css ?? []) {
    assets.css.add(cssFile);
  }
  for (const importKey of chunk.imports ?? []) {
    collectEntryAssets(manifest, importKey, visited, assets);
  }
}

function difference(source, baseline) {
  return new Set([...source].filter((file) => !baseline.has(file)));
}

function matchesCondition(condition, env) {
  if (!condition) {
    return true;
  }
  const value = String(env[condition.env] ?? '').trim();
  if (typeof condition.equals === 'string') {
    return value === condition.equals;
  }
  if (typeof condition.matches === 'string') {
    return new RegExp(condition.matches, 'u').test(value);
  }
  throw new Error(`Unsupported budget allowance condition for ${condition.env}.`);
}
