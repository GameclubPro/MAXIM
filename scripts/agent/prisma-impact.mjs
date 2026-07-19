import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const schemaPath = 'apps/api/prisma/schema.prisma';

export function assessPrismaSchemaImpact(changeSet) {
  if (!changeSet?.changedPaths?.includes(schemaPath)) {
    return Object.freeze({ schemaChanged: false, migrationRequired: false, configOnly: false });
  }

  const repoRoot = changeSet.repoRoot ?? process.cwd();
  const previous = readSchemaVersion(repoRoot, previousSchemaSource(changeSet.source));
  const current = readSchemaVersion(repoRoot, currentSchemaSource(changeSet.source));
  const migrationRequired =
    previous === null ||
    current === null ||
    stripPrismaRuntimeOnlyBlocks(previous) !== stripPrismaRuntimeOnlyBlocks(current);

  return Object.freeze({
    schemaChanged: true,
    migrationRequired,
    configOnly: !migrationRequired,
  });
}

export function stripPrismaRuntimeOnlyBlocks(source) {
  const kept = [];
  let skippedDepth = 0;

  for (const line of String(source).split(/\r?\n/u)) {
    if (
      skippedDepth === 0 &&
      /^\s*(?:generator|datasource)\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/u.test(line)
    ) {
      skippedDepth = braceDelta(line);
      if (skippedDepth <= 0) {
        skippedDepth = 0;
      }
      continue;
    }
    if (skippedDepth > 0) {
      skippedDepth += braceDelta(line);
      if (skippedDepth <= 0) {
        skippedDepth = 0;
      }
      continue;
    }
    kept.push(line);
  }

  return kept.join('\n').replace(/\s+/gu, ' ').trim();
}

function previousSchemaSource(source) {
  return source.mode === 'range' ? { kind: 'git', ref: source.base } : { kind: 'git', ref: 'HEAD' };
}

function currentSchemaSource(source) {
  if (source.mode === 'range') {
    return { kind: 'git', ref: source.head };
  }
  if (source.mode === 'staged') {
    return { kind: 'index' };
  }
  return { kind: 'worktree' };
}

function readSchemaVersion(repoRoot, source) {
  if (source.kind === 'worktree') {
    const path = resolve(repoRoot, schemaPath);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  }

  const object = source.kind === 'index' ? `:${schemaPath}` : `${source.ref}:${schemaPath}`;
  try {
    return execFileSync('git', ['show', object], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function braceDelta(line) {
  return (line.match(/\{/gu)?.length ?? 0) - (line.match(/\}/gu)?.length ?? 0);
}
