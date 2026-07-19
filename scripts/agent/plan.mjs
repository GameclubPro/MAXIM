#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { collectGitChanges } from './git-changes.mjs';
import { DEFAULT_CONFIG_PATH, loadImpactConfig } from './impact-config.mjs';
import { assessPrismaSchemaImpact } from './prisma-impact.mjs';
import {
  createImpactPlan,
  renderImpactPlanHuman,
  renderImpactPlanJson,
} from './impact-plan.mjs';

export async function runImpactPlanCli(argv = process.argv.slice(2), io = defaultIo()) {
  const options = parseImpactPlanArgs(argv);
  if (options.help) {
    io.stdout(usage());
    return 0;
  }

  const config = await loadImpactConfig(options.configPath);
  const changeSet = collectGitChanges({
    cwd: options.repo,
    mode: options.mode,
    base: options.base,
    head: options.head,
  });
  const plan = createImpactPlan({
    config,
    changeSet,
    prismaSchemaImpact: assessPrismaSchemaImpact(changeSet),
  });
  io.stdout(
    options.format === 'json'
      ? renderImpactPlanJson(plan)
      : renderImpactPlanHuman(plan, config),
  );
  return 0;
}

export function parseImpactPlanArgs(argv) {
  const options = {
    mode: 'worktree',
    modeWasExplicit: false,
    base: null,
    head: null,
    format: 'human',
    repo: process.cwd(),
    configPath: DEFAULT_CONFIG_PATH,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--worktree' || argument === '--staged') {
      setMode(options, argument.slice(2));
      continue;
    }
    if (argument === '--base') {
      options.base = requireValue(argv, ++index, argument);
      continue;
    }
    if (argument === '--head') {
      options.head = requireValue(argv, ++index, argument);
      continue;
    }
    if (argument === '--format') {
      options.format = requireValue(argv, ++index, argument);
      continue;
    }
    if (argument === '--json') {
      options.format = 'json';
      continue;
    }
    if (argument === '--repo') {
      options.repo = requireValue(argv, ++index, argument);
      continue;
    }
    if (argument === '--config') {
      options.configPath = requireValue(argv, ++index, argument);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}.\n\n${usage()}`);
  }

  if (!['human', 'json'].includes(options.format)) {
    throw new Error(`--format must be human or json, received ${options.format}.`);
  }
  if (options.base || options.head) {
    if (options.modeWasExplicit) {
      throw new Error('--base/--head cannot be combined with --worktree or --staged.');
    }
    if (!options.base) {
      throw new Error('--head requires --base.');
    }
    options.mode = 'range';
    options.head ??= 'HEAD';
  }

  delete options.modeWasExplicit;
  return options;
}

export function usage() {
  return `Usage:
  node scripts/agent/plan.mjs [--worktree] [--format human|json]
  node scripts/agent/plan.mjs --staged [--format human|json]
  node scripts/agent/plan.mjs --base <git-ref> [--head <git-ref>] [--format human|json]

Options:
  --worktree       Include staged, unstaged, deleted, renamed, and untracked files (default).
  --staged         Compare HEAD with the Git index only.
  --base <ref>     Compare two committed refs; --head defaults to HEAD.
  --head <ref>     Head ref for --base mode.
  --format <kind>  Render human-readable output or deterministic JSON.
  --json           Alias for --format json.
  --repo <path>    Run against another Git worktree.
  --config <path>  Use another impact configuration.
  --help           Show this help.
`;
}

function setMode(options, mode) {
  if (options.modeWasExplicit && options.mode !== mode) {
    throw new Error('--worktree and --staged are mutually exclusive.');
  }
  options.mode = mode;
  options.modeWasExplicit = true;
}

function requireValue(argv, index, argument) {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value.`);
  }
  return value;
}

function defaultIo() {
  return {
    stdout(value) {
      process.stdout.write(value);
    },
    stderr(value) {
      process.stderr.write(value);
    },
  };
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  runImpactPlanCli().catch((error) => {
    process.stderr.write(`agent impact plan failed: ${error.message}\n`);
    process.exitCode = 2;
  });
}
