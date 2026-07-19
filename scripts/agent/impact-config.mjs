import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG_PATH = resolve(
  import.meta.dirname,
  '..',
  '..',
  'config',
  'change-impact.json',
);

export async function loadImpactConfig(configPath = DEFAULT_CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read impact config ${configPath}: ${error.message}`, { cause: error });
  }

  return validateImpactConfig(parsed, configPath);
}

export function validateImpactConfig(config, source = '<impact-config>') {
  assertObject(config, source);
  if (config.schemaVersion !== 1) {
    throw new Error(`${source}: schemaVersion must be 1.`);
  }

  const checks = validateDefinitions(config.checks, 'checks', source);
  const deployComponents = validateDefinitions(
    config.deployComponents,
    'deployComponents',
    source,
  );
  const manualOperations = validateDefinitions(
    config.manualOperations,
    'manualOperations',
    source,
  );
  const forbiddenFragments = requireStringArray(
    config.forbiddenRoutineTargetFragments,
    'forbiddenRoutineTargetFragments',
    source,
  ).map((fragment) => fragment.toLowerCase());

  for (const component of deployComponents.items) {
    assertRoutineTargetAllowed(component.id, forbiddenFragments, source);
  }

  if (!Array.isArray(config.rules) || config.rules.length === 0) {
    throw new Error(`${source}: rules must be a non-empty array.`);
  }

  const ruleIds = new Set();
  const rules = config.rules.map((rule, index) => {
    const location = `${source}: rules[${index}]`;
    assertObject(rule, location);
    const id = requireId(rule.id, `${location}.id`);
    if (ruleIds.has(id)) {
      throw new Error(`${source}: duplicate rule id ${id}.`);
    }
    ruleIds.add(id);

    const include = requireStringArray(rule.include, 'include', location);
    if (include.length === 0) {
      throw new Error(`${location}: include must not be empty.`);
    }
    const exclude = optionalStringArray(rule.exclude, 'exclude', location);
    const ruleChecks = validateReferences(rule.checks, checks.ids, 'checks', location);
    const ruleComponents = validateReferences(
      rule.deployComponents,
      deployComponents.ids,
      'deployComponents',
      location,
    );
    const ruleOperations = validateReferences(
      rule.manualOperations ?? [],
      manualOperations.ids,
      'manualOperations',
      location,
    );
    const warnings = optionalStringArray(rule.warnings, 'warnings', location);
    const migrationImpact = rule.migrationImpact ?? null;
    if (
      migrationImpact !== null &&
      !['schema', 'migration', 'tooling'].includes(migrationImpact)
    ) {
      throw new Error(`${location}: unsupported migrationImpact ${migrationImpact}.`);
    }

    for (const component of ruleComponents) {
      assertRoutineTargetAllowed(component, forbiddenFragments, location);
    }

    return Object.freeze({
      id,
      include: Object.freeze([...include]),
      exclude: Object.freeze([...exclude]),
      checks: Object.freeze([...ruleChecks]),
      deployComponents: Object.freeze([...ruleComponents]),
      manualOperations: Object.freeze([...ruleOperations]),
      warnings: Object.freeze([...warnings]),
      migrationImpact,
    });
  });

  const fallbackLocation = `${source}: fallback`;
  assertObject(config.fallback, fallbackLocation);
  const fallbackChecks = validateReferences(
    config.fallback.checks,
    checks.ids,
    'checks',
    fallbackLocation,
  );
  const fallbackComponents = validateReferences(
    config.fallback.deployComponents,
    deployComponents.ids,
    'deployComponents',
    fallbackLocation,
  );
  const fallbackOperations = validateReferences(
    config.fallback.manualOperations ?? [],
    manualOperations.ids,
    'manualOperations',
    fallbackLocation,
  );
  if (typeof config.fallback.warning !== 'string' || !config.fallback.warning.trim()) {
    throw new Error(`${fallbackLocation}: warning must be a non-empty string.`);
  }
  if (fallbackChecks.length === 0 || fallbackComponents.length === 0) {
    throw new Error(`${fallbackLocation}: checks and deployComponents must fail closed.`);
  }
  for (const component of fallbackComponents) {
    assertRoutineTargetAllowed(component, forbiddenFragments, fallbackLocation);
  }

  return Object.freeze({
    schemaVersion: 1,
    source,
    checks: Object.freeze(checks.items),
    checkIds: Object.freeze([...checks.ids]),
    checkById: checks.byId,
    deployComponents: Object.freeze(deployComponents.items),
    deployComponentIds: Object.freeze([...deployComponents.ids]),
    deployComponentById: deployComponents.byId,
    manualOperations: Object.freeze(manualOperations.items),
    manualOperationIds: Object.freeze([...manualOperations.ids]),
    manualOperationById: manualOperations.byId,
    forbiddenRoutineTargetFragments: Object.freeze(forbiddenFragments),
    rules: Object.freeze(rules),
    fallback: Object.freeze({
      checks: Object.freeze([...fallbackChecks]),
      deployComponents: Object.freeze([...fallbackComponents]),
      manualOperations: Object.freeze([...fallbackOperations]),
      warning: config.fallback.warning.trim(),
    }),
  });
}

export function matchesImpactPattern(path, pattern) {
  const normalizedPath = normalizeRepoPath(path);
  const normalizedPattern = normalizeRepoPath(pattern);
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

export function matchesImpactRule(path, rule) {
  const included = rule.include.some((pattern) => matchesImpactPattern(path, pattern));
  if (!included) {
    return false;
  }
  return !rule.exclude.some((pattern) => matchesImpactPattern(path, pattern));
}

export function normalizeRepoPath(value) {
  if (typeof value !== 'string') {
    throw new TypeError('Repository path must be a string.');
  }
  return value.replaceAll('\\', '/').replace(/^\.\//u, '').replace(/^\/+|\/+$/gu, '');
}

function globToRegExp(pattern) {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += escapeRegExp(character);
  }
  source += '$';
  return new RegExp(source, 'u');
}

function validateDefinitions(value, field, source) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source}: ${field} must be a non-empty array.`);
  }
  const ids = new Set();
  const items = value.map((item, index) => {
    const location = `${source}: ${field}[${index}]`;
    assertObject(item, location);
    const id = requireId(item.id, `${location}.id`);
    if (ids.has(id)) {
      throw new Error(`${source}: duplicate ${field} id ${id}.`);
    }
    if (typeof item.label !== 'string' || !item.label.trim()) {
      throw new Error(`${location}: label must be a non-empty string.`);
    }
    ids.add(id);
    const script = item.script;
    if (script !== undefined && (typeof script !== 'string' || !/^[a-z0-9][a-z0-9:-]*$/u.test(script))) {
      throw new Error(`${location}: script must be an npm script id.`);
    }
    return Object.freeze({ id, label: item.label.trim(), ...(script ? { script } : {}) });
  });
  return {
    items,
    ids,
    byId: Object.freeze(Object.fromEntries(items.map((item) => [item.id, item]))),
  };
}

function validateReferences(value, knownIds, field, source) {
  const references = requireStringArray(value, field, source);
  for (const reference of references) {
    if (!knownIds.has(reference)) {
      throw new Error(`${source}: unknown ${field} reference ${reference}.`);
    }
  }
  return references;
}

function assertRoutineTargetAllowed(target, forbiddenFragments, source) {
  const normalized = target.toLowerCase();
  const forbidden = forbiddenFragments.find((fragment) => normalized.includes(fragment));
  if (forbidden) {
    throw new Error(`${source}: routine deploy target ${target} contains forbidden fragment ${forbidden}.`);
  }
}

function optionalStringArray(value, field, source) {
  if (value === undefined) {
    return [];
  }
  return requireStringArray(value, field, source);
}

function requireStringArray(value, field, source) {
  if (!Array.isArray(value)) {
    throw new Error(`${source}: ${field} must be an array.`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${source}: ${field} entries must be non-empty strings.`);
    }
    const normalized = item.trim();
    if (seen.has(normalized)) {
      throw new Error(`${source}: duplicate ${field} entry ${normalized}.`);
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function requireId(value, location) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) {
    throw new Error(`${location} must match [a-z][a-z0-9-]*.`);
  }
  return value;
}

function assertObject(value, location) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object.`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
}
