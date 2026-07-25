import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const baselineFormat = 1;
const baselineRelativePath = 'config/prisma-drift-baseline.json';
const baselineClassifications = Object.freeze([
  'prisma-unrepresentable',
  'schema-alignment-debt',
  'missing-migration-debt',
]);

export function normalizePrismaDiff(output) {
  if (typeof output !== 'string') {
    throw new TypeError('Prisma diff output must be a string.');
  }

  return output.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
}

export function splitPrismaDiffOperations(normalizedOutput) {
  const normalized = normalizePrismaDiff(normalizedOutput);
  return normalized === '' ? [] : normalized.split(/\n{2,}/u);
}

export function digestPrismaDiff(normalizedOutput) {
  return createHash('sha256').update(normalizePrismaDiff(normalizedOutput)).digest('hex');
}

function countOperationDifference(source, target) {
  const remaining = new Map();
  for (const operation of target) {
    remaining.set(operation, (remaining.get(operation) ?? 0) + 1);
  }

  const difference = [];
  for (const operation of source) {
    const count = remaining.get(operation) ?? 0;
    if (count === 0) {
      difference.push(operation);
    } else {
      remaining.set(operation, count - 1);
    }
  }
  return difference;
}

export function validatePrismaDriftBaseline(baseline) {
  if (baseline?.format !== baselineFormat) {
    throw new Error(`Prisma drift baseline format must be ${baselineFormat}.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(baseline.normalizedSha256 ?? '')) {
    throw new Error('Prisma drift baseline normalizedSha256 must be a SHA-256 digest.');
  }
  if (!Array.isArray(baseline.operationGroups) || baseline.operationGroups.length === 0) {
    throw new Error('Prisma drift baseline must contain classified operationGroups.');
  }

  const classificationMetadata = baseline.classifications;
  if (
    classificationMetadata === null ||
    typeof classificationMetadata !== 'object' ||
    Array.isArray(classificationMetadata)
  ) {
    throw new Error('Prisma drift baseline must document its classifications.');
  }
  for (const classification of Object.keys(classificationMetadata)) {
    if (!baselineClassifications.includes(classification)) {
      throw new Error(`Unknown Prisma drift classification metadata: ${classification}.`);
    }
  }

  const operations = [];
  const classificationCounts = Object.fromEntries(
    baselineClassifications.map((classification) => [classification, 0]),
  );
  for (const group of baseline.operationGroups) {
    if (!baselineClassifications.includes(group?.classification)) {
      throw new Error(`Unknown Prisma drift classification: ${String(group?.classification)}.`);
    }
    const metadata = classificationMetadata[group.classification];
    if (!metadata?.description?.trim() || !metadata?.remediation?.trim()) {
      throw new Error(
        `Prisma drift classification ${group.classification} needs description and remediation metadata.`,
      );
    }
    if (!Array.isArray(group.operations) || group.operations.length === 0) {
      throw new Error(`Prisma drift classification ${group.classification} has no operations.`);
    }

    for (const operation of group.operations) {
      if (
        typeof operation !== 'string' ||
        operation === '' ||
        normalizePrismaDiff(operation) !== operation ||
        splitPrismaDiffOperations(operation).length !== 1
      ) {
        throw new Error(
          'Prisma drift baseline operations must be non-empty canonical diff blocks.',
        );
      }
      operations.push(operation);
      classificationCounts[group.classification] += 1;
    }
  }
  for (const classification of Object.keys(classificationMetadata)) {
    if (classificationCounts[classification] === 0) {
      throw new Error(`Prisma drift classification metadata is unused: ${classification}.`);
    }
  }

  const normalizedOutput = operations.join('\n\n');
  const calculatedSha256 = digestPrismaDiff(normalizedOutput);
  if (calculatedSha256 !== baseline.normalizedSha256) {
    throw new Error(
      `Prisma drift baseline digest is stale: expected ${baseline.normalizedSha256}, calculated ${calculatedSha256}.`,
    );
  }

  return {
    normalizedOutput,
    normalizedSha256: calculatedSha256,
    operations,
    classificationCounts,
  };
}

export function comparePrismaDrift(commandOutput, baseline) {
  const expected = validatePrismaDriftBaseline(baseline);
  const normalizedOutput = normalizePrismaDiff(commandOutput);
  const operations = splitPrismaDiffOperations(normalizedOutput);
  const normalizedSha256 = digestPrismaDiff(normalizedOutput);
  const firstDifferentOperation = operations.findIndex(
    (operation, index) => operation !== expected.operations[index],
  );
  const orderOnlyDifference =
    normalizedOutput !== expected.normalizedOutput &&
    countOperationDifference(operations, expected.operations).length === 0 &&
    countOperationDifference(expected.operations, operations).length === 0;

  return {
    matches: normalizedOutput === expected.normalizedOutput,
    expectedSha256: expected.normalizedSha256,
    actualSha256: normalizedSha256,
    added: countOperationDifference(operations, expected.operations),
    removed: countOperationDifference(expected.operations, operations),
    firstDifferentOperation,
    orderOnlyDifference,
    classificationCounts: expected.classificationCounts,
  };
}

export function invokePinnedPrismaDiff({ root, env = process.env, spawn = spawnSync }) {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the migrated-database drift check.');
  }

  const apiRoot = resolve(root, 'apps/api');
  const prismaBinary = resolve(
    root,
    'node_modules/.bin',
    process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
  );
  if (spawn === spawnSync && !existsSync(prismaBinary)) {
    throw new Error(
      `Pinned repository Prisma binary is missing: ${prismaBinary}. Run npm ci first.`,
    );
  }

  const args = [
    'migrate',
    'diff',
    '--from-config-datasource',
    '--to-schema',
    'prisma/schema.prisma',
    '--script',
    '--config',
    'prisma.config.ts',
  ];
  const result = spawn(prismaBinary, args, {
    cwd: apiRoot,
    encoding: 'utf8',
    env: { ...env, DATABASE_URL: databaseUrl },
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw new Error(`Unable to run pinned repository Prisma: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const diagnostics = normalizePrismaDiff(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    throw new Error(
      `Prisma migrate diff failed with exit code ${String(result.status)}${
        diagnostics === '' ? '.' : `:\n${diagnostics}`
      }`,
    );
  }

  return result.stdout ?? '';
}

export function loadPrismaDriftBaseline(root) {
  const baselinePath = resolve(root, baselineRelativePath);
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read ${baselineRelativePath}: ${error.message}`);
  }
  return baseline;
}

export function checkPrismaDrift({
  root,
  env = process.env,
  runDiff = () => invokePinnedPrismaDiff({ root, env }),
  baseline = loadPrismaDriftBaseline(root),
}) {
  return comparePrismaDrift(runDiff(), baseline);
}

function indentOperation(operation, marker) {
  return operation
    .split('\n')
    .map((line, index) => `  ${index === 0 ? marker : ' '} ${line}`)
    .join('\n');
}

export function formatPrismaDriftFailure(comparison) {
  const lines = [
    'Migrated PostgreSQL schema differs from the committed known-drift baseline.',
    `Expected SHA-256: ${comparison.expectedSha256}`,
    `Actual SHA-256:   ${comparison.actualSha256}`,
    `Reviewed baseline: ${formatClassificationCounts(comparison.classificationCounts)}`,
  ];

  if (comparison.added.length > 0) {
    lines.push(
      '',
      'Unexpected drift added (a Prisma schema change may be missing a migration):',
      ...comparison.added.map((operation) => indentOperation(operation, '+')),
    );
  }
  if (comparison.removed.length > 0) {
    lines.push(
      '',
      'Known drift removed or changed (review the schema and migration history):',
      ...comparison.removed.map((operation) => indentOperation(operation, '-')),
    );
  }
  if (comparison.orderOnlyDifference) {
    lines.push(
      '',
      `The operation set is unchanged, but exact output order differs at operation ${String(
        comparison.firstDifferentOperation + 1,
      )}.`,
    );
  }

  lines.push(
    '',
    `If this is intentional reviewed database/schema debt, update ${baselineRelativePath}`,
    'operations plus normalizedSha256 in the same change. Never edit applied migration history.',
  );
  return lines.join('\n');
}

export function formatClassificationCounts(counts) {
  return baselineClassifications
    .filter((classification) => (counts[classification] ?? 0) > 0)
    .map((classification) => `${classification}=${String(counts[classification])}`)
    .join(', ');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = resolve(import.meta.dirname, '..');
  try {
    const comparison = checkPrismaDrift({ root });
    if (!comparison.matches) {
      console.error(formatPrismaDriftFailure(comparison));
      process.exitCode = 1;
    } else {
      console.log(
        `Migrated PostgreSQL schema matches the reviewed known-drift baseline (${comparison.actualSha256}; ${formatClassificationCounts(comparison.classificationCounts)}).`,
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
