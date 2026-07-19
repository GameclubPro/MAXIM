#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectGitChanges } from './git-changes.mjs';
import { createImpactPlan, renderImpactPlanHuman } from './impact-plan.mjs';
import { DEFAULT_CONFIG_PATH, loadImpactConfig } from './impact-config.mjs';
import { parseImpactPlanArgs } from './plan.mjs';
import { assessPrismaSchemaImpact } from './prisma-impact.mjs';

export function parseVerifyArgs(argv) {
  let full = false;
  let dryRun = false;
  const planArgs = [];

  for (const argument of argv) {
    if (argument === '--full') {
      full = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else {
      planArgs.push(argument);
    }
  }

  const planOptions = parseImpactPlanArgs(planArgs);
  if (full && (planOptions.mode !== 'worktree' || planOptions.base || planOptions.head)) {
    throw new Error('--full cannot be combined with staged or range selection.');
  }

  return { ...planOptions, full, dryRun };
}

export function selectVerificationScripts({ config, plan, full = false }) {
  let checkIds = full ? ['full'] : [...plan.checks];
  if (checkIds.includes('full')) {
    checkIds = ['full'];
  }

  return checkIds.map((id) => {
    const definition = config.checkById[id];
    if (!definition?.script) {
      throw new Error(`Impact check ${id} has no npm script mapping.`);
    }
    return Object.freeze({ id, script: definition.script });
  });
}

export async function runVerifyCli(argv = process.argv.slice(2), io = defaultIo()) {
  const options = parseVerifyArgs(argv);
  const config = await loadImpactConfig(options.configPath ?? DEFAULT_CONFIG_PATH);
  let plan = null;

  if (!options.full) {
    const changeSet = collectGitChanges({
      cwd: options.repo,
      mode: options.mode,
      base: options.base,
      head: options.head,
    });
    plan = createImpactPlan({
      config,
      changeSet,
      prismaSchemaImpact: assessPrismaSchemaImpact(changeSet),
    });
    io.stdout(renderImpactPlanHuman(plan, config));
    if (plan.migration.reviewRequired) {
      throw new Error('Verification stopped: a Prisma migration review is required.');
    }
  }

  const scripts = selectVerificationScripts({ config, plan, full: options.full });
  await assertScriptsExist(options.repo, scripts);
  io.stdout(
    `Verification commands:\n${scripts.map(({ script }) => `  npm run ${script}`).join('\n')}\n`,
  );

  if (options.dryRun) {
    return 0;
  }

  for (const { id, script } of scripts) {
    io.stdout(`\n[agent:verify] ${id} -> npm run ${script}\n`);
    await runNpmScript(options.repo, script);
  }
  return 0;
}

async function assertScriptsExist(repo, scripts) {
  const packageJson = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
  for (const { script } of scripts) {
    if (typeof packageJson.scripts?.[script] !== 'string') {
      throw new Error(`package.json is missing the mapped npm script ${script}.`);
    }
  }
}

function runNpmScript(cwd, script) {
  const child = spawn('npm', ['run', script], {
    cwd,
    env: { ...process.env, MAXIM_AGENT_VERIFY: '1' },
    stdio: 'inherit',
  });
  return new Promise((resolveRun, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      reject(
        new Error(`npm run ${script} failed${signal ? ` with ${signal}` : ` with code ${code}`}.`),
      );
    });
  });
}

function defaultIo() {
  return {
    stdout(value) {
      process.stdout.write(value);
    },
  };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runVerifyCli().catch((error) => {
    process.stderr.write(`agent verification failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
