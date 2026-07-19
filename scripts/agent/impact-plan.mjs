import { matchesImpactRule, normalizeRepoPath } from './impact-config.mjs';

export function createImpactPlan({ config, changeSet, prismaSchemaImpact = null }) {
  if (!config || !changeSet) {
    throw new TypeError('createImpactPlan requires config and changeSet.');
  }

  const changedFiles = [...new Set(changeSet.changedPaths.map(normalizeRepoPath))].sort(compareText);
  const matchedPathsByRule = new Map(config.rules.map((rule) => [rule.id, []]));
  const matchedRuleIdsByPath = new Map();
  const unknownPaths = [];
  const selectedChecks = new Set();
  const selectedComponents = new Set();
  const selectedOperations = new Set();
  const warningSet = new Set();
  const migrationKinds = new Set();

  for (const path of changedFiles) {
    const matchedRules = config.rules.filter((rule) => matchesImpactRule(path, rule));
    if (matchedRules.length === 0) {
      unknownPaths.push(path);
      addAll(selectedChecks, config.fallback.checks);
      addAll(selectedComponents, config.fallback.deployComponents);
      addAll(selectedOperations, config.fallback.manualOperations);
      warningSet.add(`${config.fallback.warning} Path: ${path}`);
      matchedRuleIdsByPath.set(path, []);
      continue;
    }

    const ids = [];
    for (const rule of matchedRules) {
      ids.push(rule.id);
      matchedPathsByRule.get(rule.id).push(path);
      addAll(selectedChecks, rule.checks);
      addAll(selectedComponents, rule.deployComponents);
      addAll(selectedOperations, rule.manualOperations);
      addAll(warningSet, rule.warnings);
      if (rule.migrationImpact) {
        migrationKinds.add(rule.migrationImpact);
      }
    }
    matchedRuleIdsByPath.set(path, ids);
  }

  const migrationFiles = activeMigrationFiles(changeSet.changes);
  const schemaChanged = migrationKinds.has('schema');
  const migrationRequired = schemaChanged && (prismaSchemaImpact?.migrationRequired ?? true);
  const configOnly = schemaChanged && prismaSchemaImpact?.configOnly === true;
  const migrationPresent = migrationFiles.length > 0;
  const migrationReviewRequired = migrationRequired && !migrationPresent;
  if (migrationReviewRequired) {
    warningSet.add(
      'Prisma schema changed without a changed migration.sql; confirm a config-only exception or add the required migration.',
    );
  }

  const matchedRules = config.rules
    .map((rule) => ({ id: rule.id, paths: matchedPathsByRule.get(rule.id) }))
    .filter((entry) => entry.paths.length > 0)
    .map((entry) => Object.freeze({ id: entry.id, paths: Object.freeze([...entry.paths]) }));

  const checks = orderedSelections(config.checks, selectedChecks);
  const deployComponents = orderedSelections(config.deployComponents, selectedComponents);
  const manualOperations = orderedSelections(config.manualOperations, selectedOperations);
  assertNoForbiddenRoutineTargets(config, deployComponents);

  const changes = [...changeSet.changes]
    .map((change) => normalizeChange(change))
    .sort(compareChanges);
  const fileImpacts = changedFiles.map((path) =>
    Object.freeze({
      path,
      matchedRules: Object.freeze([...(matchedRuleIdsByPath.get(path) ?? [])]),
      classified: (matchedRuleIdsByPath.get(path) ?? []).length > 0,
    }),
  );

  return Object.freeze({
    schemaVersion: 1,
    source: Object.freeze({ ...changeSet.source }),
    changes: Object.freeze(changes),
    changedFiles: Object.freeze(changedFiles),
    fileImpacts: Object.freeze(fileImpacts),
    matchedRules: Object.freeze(matchedRules),
    unknownPaths: Object.freeze([...unknownPaths]),
    checks: Object.freeze(checks),
    migration: Object.freeze({
      schemaChanged,
      configOnly,
      migrationFiles: Object.freeze(migrationFiles),
      required: migrationRequired,
      present: migrationPresent,
      reviewRequired: migrationReviewRequired,
    }),
    deploy: Object.freeze({
      required: deployComponents.length > 0,
      components: Object.freeze(deployComponents),
      manualOperations: Object.freeze(manualOperations),
      reviewRequired: unknownPaths.length > 0 || manualOperations.length > 0,
    }),
    warnings: Object.freeze([...warningSet].sort(compareText)),
  });
}

function activeMigrationFiles(changes) {
  const migrationPattern = /^apps\/api\/prisma\/migrations\/.+\/migration\.sql$/u;
  const paths = [];

  for (const change of changes) {
    const status = String(change.status ?? '');
    if (change.oldPath && change.newPath) {
      if (!status.includes('D') && migrationPattern.test(normalizeRepoPath(change.newPath))) {
        paths.push(normalizeRepoPath(change.newPath));
      }
      continue;
    }
    const path = normalizeRepoPath(change.path ?? change.paths?.[0]);
    if (!status.includes('D') && migrationPattern.test(path)) {
      paths.push(path);
    }
  }

  return [...new Set(paths)].sort(compareText);
}

export function renderImpactPlanHuman(plan, config) {
  const lines = [`Agent impact plan (${formatSource(plan.source)})`];
  if (plan.changedFiles.length === 0) {
    lines.push('No changes detected.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('', `Changes (${plan.changes.length}):`);
  for (const change of plan.changes) {
    if (change.oldPath && change.newPath) {
      lines.push(`  ${change.status} ${change.oldPath} -> ${change.newPath}`);
    } else {
      lines.push(`  ${change.status} ${change.path}`);
    }
  }

  lines.push('', `Matched rules: ${formatList(plan.matchedRules.map((rule) => rule.id))}`);
  if (plan.unknownPaths.length > 0) {
    lines.push(`Unknown paths: ${plan.unknownPaths.join(', ')}`);
  }

  lines.push('', 'Checks:');
  appendSelections(lines, plan.checks, config.checkById);

  lines.push('', 'Prisma migration:');
  if (plan.migration.configOnly) {
    lines.push('  Not required; schema changes are limited to generator/datasource configuration.');
  } else if (!plan.migration.required && plan.migration.migrationFiles.length === 0) {
    lines.push('  Not required by the changed paths.');
  } else if (plan.migration.reviewRequired) {
    lines.push('  Required; no changed migration.sql was detected.');
  } else if (plan.migration.migrationFiles.length > 0) {
    lines.push(`  Changed migrations: ${plan.migration.migrationFiles.join(', ')}`);
  }

  lines.push('', 'Deploy components:');
  appendSelections(lines, plan.deploy.components, config.deployComponentById);
  lines.push('Manual operations:');
  appendSelections(lines, plan.deploy.manualOperations, config.manualOperationById);

  if (plan.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const warning of plan.warnings) {
      lines.push(`  - ${warning}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function renderImpactPlanJson(plan) {
  return `${JSON.stringify(plan, null, 2)}\n`;
}

function orderedSelections(definitions, selectedIds) {
  return definitions.filter((definition) => selectedIds.has(definition.id)).map(({ id }) => id);
}

function normalizeChange(change) {
  const status = String(change.status);
  if (change.oldPath && change.newPath) {
    const oldPath = normalizeRepoPath(change.oldPath);
    const newPath = normalizeRepoPath(change.newPath);
    return Object.freeze({
      status,
      oldPath,
      newPath,
      paths: Object.freeze([oldPath, newPath]),
    });
  }
  const path = normalizeRepoPath(change.path ?? change.paths?.[0]);
  return Object.freeze({ status, path, paths: Object.freeze([path]) });
}

function assertNoForbiddenRoutineTargets(config, components) {
  for (const component of components) {
    const normalized = component.toLowerCase();
    const forbidden = config.forbiddenRoutineTargetFragments.find((fragment) =>
      normalized.includes(fragment),
    );
    if (forbidden) {
      throw new Error(
        `Impact plan selected forbidden routine target ${component} (${forbidden}).`,
      );
    }
  }
}

function appendSelections(lines, ids, definitions) {
  if (ids.length === 0) {
    lines.push('  None.');
    return;
  }
  for (const id of ids) {
    lines.push(`  - ${id}: ${definitions[id].label}`);
  }
}

function formatSource(source) {
  if (source.mode === 'range') {
    return `${source.base}..${source.head}`;
  }
  if (source.mode === 'staged') {
    return 'staged HEAD..INDEX';
  }
  return 'worktree including staged, unstaged, and untracked files';
}

function formatList(values) {
  return values.length > 0 ? values.join(', ') : 'none';
}

function addAll(target, values) {
  for (const value of values) {
    target.add(value);
  }
}

function compareChanges(left, right) {
  const leftPath = left.oldPath ?? left.path;
  const rightPath = right.oldPath ?? right.path;
  const pathOrder = compareText(leftPath, rightPath);
  if (pathOrder !== 0) {
    return pathOrder;
  }
  return compareText(left.newPath ?? '', right.newPath ?? '') || compareText(left.status, right.status);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
