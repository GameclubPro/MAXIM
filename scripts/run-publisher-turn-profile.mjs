import { spawn } from 'node:child_process';
import { existsSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateProfileEnvironment(env) {
  let url;
  try {
    url = new URL(env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? 'missing:');
  } catch {
    throw new Error('Publisher profile requires an isolated local race_test PostgreSQL database.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/maxim_race_test_[a-zA-Z0-9_]+$/u.test(url.pathname) ||
    (url.search !== '' && url.search !== '?schema=public') ||
    url.hash ||
    env.TZ !== 'UTC'
  ) {
    throw new Error(
      'Publisher profile requires an isolated local race_test PostgreSQL database and UTC.',
    );
  }
  return url.href;
}

export function parseProfileArguments(args) {
  let mode = 'full';
  let output;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--smoke') mode = 'smoke';
    else if (args[i] === '--output' && args[i + 1]) output = args[++i];
    else
      throw new Error(
        'Usage: test:publisher-full-turn-profile -- [--smoke] --output <new absolute .json>',
      );
  }
  if (!output || !isAbsolute(output) || !output.endsWith('.json') || existsSync(output)) {
    throw new Error('Profile output must be a new absolute .json path.');
  }
  const parent = lstatSync(dirname(output));
  if (!parent.isDirectory() || parent.isSymbolicLink())
    throw new Error('Unsafe profile output directory.');
  return { mode, output, deadlineMs: mode === 'smoke' ? 300_000 : 2_700_000 };
}

async function main() {
  const options = parseProfileArguments(process.argv.slice(2));
  validateProfileEnvironment(process.env);
  const cwd = resolve(import.meta.dirname, '../apps/api');
  const env = {
    ...process.env,
    APP_ROLE: 'publisher',
    MAXIM_PUBLISHER_DISPATCH_ENABLED: 'true',
    PUBLISHER_TEMPORAL_SELECTION_ROLLOUT: 'off',
    MAXIM_PUBLISHER_TURN_PROFILE: options.mode,
    MAXIM_PUBLISHER_TURN_PROFILE_OUTPUT: options.output,
  };
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + options.deadlineMs;
  let activeChild;
  let interrupted = false;
  let termination;
  const terminate = (child) => {
    if (!child?.pid) return Promise.resolve();
    if (termination) return termination;
    const group = child.pid;
    try {
      process.kill(-group, 'SIGTERM');
    } catch {
      /* Already exited. */
    }
    // The npm leader may exit before descendants. Retain this timer and await the
    // group cleanup before releasing api-validation, even after the leader exits.
    termination = new Promise((resolveTermination) =>
      setTimeout(() => {
        try {
          process.kill(-group, 'SIGKILL');
        } catch {
          /* Group already exited. */
        }
        resolveTermination();
      }, 5000),
    );
    return termination;
  };
  const stop = () => {
    interrupted = true;
    void terminate(activeChild);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const execute = (command, args) =>
    new Promise((resolveExit, reject) => {
      if (interrupted || Date.now() >= deadline) {
        reject(new Error('Profile deadline or interruption'));
        return;
      }
      const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached: true });
      activeChild = child;
      const timer = setTimeout(() => {
        stop();
      }, deadline - Date.now());
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', async (code) => {
        clearTimeout(timer);
        if (code !== 0 || interrupted) await terminate(child);
        activeChild = undefined;
        if (code === 0 && !interrupted) resolveExit();
        else reject(new Error('Profile child failed or exceeded its deadline'));
      });
    });
  try {
    // The public npm command holds api-validation for generation and the whole profile.
    await execute('npm', ['run', 'prepare:codegen']);
    await execute('npm', ['run', 'typecheck:source']);
    await execute(process.execPath, [
      '--max-old-space-size=3072',
      '../../node_modules/jest/bin/jest.js',
      '--config',
      'jest.publisher-profile.config.cjs',
      '--runInBand',
    ]);
  } catch (error) {
    if (!existsSync(options.output))
      writeFileSync(
        options.output,
        `${JSON.stringify(
          {
            schemaVersion: 1,
            status: 'failed_before_report',
            startedAt,
            endedAt: new Date().toISOString(),
            mode: options.mode,
            complete: false,
            missingCells: options.mode === 'full' ? 24 : 7,
          },
          null,
          2,
        )}\n`,
        { flag: 'wx', mode: 0o600 },
      );
    throw error;
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Profile failed');
    process.exitCode = 1;
  });
}
