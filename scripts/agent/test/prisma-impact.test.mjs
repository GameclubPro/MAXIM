import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { collectGitChanges } from '../git-changes.mjs';
import {
  assessPrismaSchemaImpact,
  stripPrismaRuntimeOnlyBlocks,
} from '../prisma-impact.mjs';

const schemaPath = 'apps/api/prisma/schema.prisma';

test('ignores only generator and datasource blocks', () => {
  const first = schema('output = "./generated/one"', 'name String');
  const configChanged = schema('output = "./generated/two"', 'name String');
  const modelChanged = schema('output = "./generated/one"', 'name String\n  age Int?');

  assert.equal(stripPrismaRuntimeOnlyBlocks(first), stripPrismaRuntimeOnlyBlocks(configChanged));
  assert.notEqual(stripPrismaRuntimeOnlyBlocks(first), stripPrismaRuntimeOnlyBlocks(modelChanged));
});

test('assesses staged config-only and model schema changes from the Git index', () => {
  const repo = mkdtempSync(join(tmpdir(), 'maxim-prisma-impact-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'agent-planner@example.invalid']);
  git(repo, ['config', 'user.name', 'Agent Planner']);
  write(repo, schemaPath, schema('output = "./generated/one"', 'name String'));
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'baseline']);

  write(repo, schemaPath, schema('output = "./generated/two"', 'name String'));
  git(repo, ['add', schemaPath]);
  assert.deepEqual(assessPrismaSchemaImpact(collectGitChanges({ cwd: repo, mode: 'staged' })), {
    schemaChanged: true,
    migrationRequired: false,
    configOnly: true,
  });

  write(repo, schemaPath, schema('output = "./generated/two"', 'name String\n  age Int?'));
  git(repo, ['add', schemaPath]);
  assert.deepEqual(assessPrismaSchemaImpact(collectGitChanges({ cwd: repo, mode: 'staged' })), {
    schemaChanged: true,
    migrationRequired: true,
    configOnly: false,
  });
});

function schema(generatorLine, modelFields) {
  return `generator client {
  provider = "prisma-client"
  ${generatorLine}
}

datasource db {
  provider = "postgresql"
}

model Example {
  id String @id
  ${modelFields}
}
`;
}

function write(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
