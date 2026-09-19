import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WAIT_MS = 30_000;
const ownedProcessGroups = new WeakSet();

export async function allocateMiniappBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!isLocalMiniappBaseUrl(baseUrl) || url.protocol !== 'http:') {
    throw new Error('An owned mini app server requires a local HTTP URL.');
  }
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, url.hostname, resolve);
  });
  url.port = String(probe.address().port);
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return url.href;
}

export function isLocalMiniappBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}

export async function waitForMiniappUrl(url, timeoutMs = DEFAULT_WAIT_MS, options = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    assertChildProcessRunning(options.childProcess, url);

    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.min(1_000, deadline - Date.now()))),
      });
      const html = await response.text();
      if (
        response.ok &&
        response.headers.get('content-type')?.includes('text/html') &&
        html.includes('/@vite/client') &&
        html.includes('/src/main.tsx') &&
        (!options.identity || response.headers.get('x-maxim-visual-server') === options.identity)
      ) {
        return;
      }
    } catch {
      // The local server may still be binding its port.
    }

    assertChildProcessRunning(options.childProcess, url);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))),
    );
  }

  throw new Error(`Timed out waiting for ${url}`);
}

export function startMiniappDevServer(baseUrl, identity = randomUUID()) {
  const url = new URL(baseUrl);
  if (!isLocalMiniappBaseUrl(baseUrl) || url.protocol !== 'http:') {
    throw new Error('An owned mini app server requires a local HTTP URL.');
  }
  const host = url.hostname;
  const port = url.port || '3000';

  const child = spawn(
    process.execPath,
    [
      path.join(ROOT_DIR, 'node_modules/vite/bin/vite.js'),
      '--host',
      host,
      '--port',
      port,
      '--strictPort',
    ],
    {
      cwd: path.join(ROOT_DIR, 'apps/miniapp'),
      stdio: 'inherit',
      env: { ...process.env, MAXIM_VISUAL_SERVER_ID: identity },
      detached: process.platform !== 'win32',
    },
  );
  if (process.platform !== 'win32') ownedProcessGroups.add(child);
  child.once('error', (error) => {
    child.startupError = error;
  });
  return child;
}

export async function ensureMiniappDevServer(baseUrl, options = {}) {
  if (options.reuseServer) {
    await waitForMiniappUrl(baseUrl, options.waitTimeoutMs ?? DEFAULT_WAIT_MS);
    options.log?.(`Reusing existing mini-app dev server at ${baseUrl}`);
    return null;
  }
  const identity = randomUUID();
  const childProcess = startMiniappDevServer(baseUrl, identity);
  try {
    await waitForMiniappUrl(baseUrl, options.waitTimeoutMs ?? DEFAULT_WAIT_MS, {
      childProcess,
      identity,
    });
    options.log?.(`Started owned mini-app dev server at ${baseUrl}`);
    return childProcess;
  } catch (error) {
    await stopChildProcess(childProcess);
    throw error;
  }
}

function assertChildProcessRunning(childProcess, url) {
  if (childProcess?.startupError) throw childProcess.startupError;
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
  if (childProcess && ownedProcessGroups.has(childProcess)) {
    const signalGroup = (signal) => {
      if (!childProcess.pid) return;
      try {
        process.kill(-childProcess.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    try {
      if (childProcess.exitCode === null && childProcess.signalCode === null && childProcess.pid) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 5_000);
          childProcess.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
          signalGroup('SIGTERM');
        });
      }
    } finally {
      signalGroup('SIGKILL');
      ownedProcessGroups.delete(childProcess);
    }
    return;
  }
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
