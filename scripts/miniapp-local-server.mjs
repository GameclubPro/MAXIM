import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WAIT_MS = 30_000;

export function isLocalMiniappBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}

export async function waitForMiniappUrl(url, timeoutMs = DEFAULT_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertChildProcessRunning(options.childProcess, url);

    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // The local server may still be binding its port.
    }

    assertChildProcessRunning(options.childProcess, url);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export function startMiniappDevServer(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = url.port || '3000';

  return spawn(
    'npm',
    ['run', 'dev', '--workspace', '@maxim/miniapp', '--', '--host', host, '--port', port],
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: process.env,
    },
  );
}

export async function ensureMiniappDevServer(baseUrl, options = {}) {
  const probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
  try {
    await waitForMiniappUrl(baseUrl, probeTimeoutMs);
    options.log?.(`Reusing existing mini-app dev server at ${baseUrl}`);
    return null;
  } catch {
    const childProcess = startMiniappDevServer(baseUrl);
    try {
      await waitForMiniappUrl(baseUrl, options.waitTimeoutMs ?? DEFAULT_WAIT_MS, {
        childProcess,
      });
      return childProcess;
    } catch (error) {
      await stopChildProcess(childProcess);
      throw error;
    }
  }
}

function assertChildProcessRunning(childProcess, url) {
  if (!childProcess || (childProcess.exitCode === null && childProcess.signalCode === null)) {
    return;
  }

  const outcome =
    childProcess.exitCode !== null
      ? `exit code ${childProcess.exitCode}`
      : `signal ${childProcess.signalCode}`;
  throw new Error(`Mini app dev server stopped with ${outcome} before ${url} became ready.`);
}

export async function stopChildProcess(childProcess) {
  if (
    !childProcess ||
    childProcess.killed ||
    childProcess.exitCode !== null ||
    childProcess.signalCode !== null
  ) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      childProcess.kill('SIGKILL');
    }, 5_000);

    childProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    childProcess.kill('SIGTERM');
  });
}
