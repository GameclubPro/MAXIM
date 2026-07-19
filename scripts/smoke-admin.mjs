#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const accessCode = 'admin-smoke-access-code';
const generatedAt = '2026-07-19T00:00:00.000Z';
const queue = {
  generatedAt,
  items: [],
  summary: { review: 0, approved: 0, rejected: 0, blocked: 0, servicePosts: 0 },
  audit: [],
};
const supportQueue = { generatedAt, items: [], summary: { new: 0, closed: 0 } };
const statusCounts = Object.fromEntries(
  [
    'OBSERVED',
    'PENDING',
    'IN_PROGRESS',
    'RETRYABLE',
    'WAITING_CAPABILITY',
    'AMBIGUOUS',
    'SUCCEEDED',
    'ALREADY_ABSENT',
    'EXPIRED',
    'FAILED_TERMINAL',
  ].map((status) => [status, 0]),
);
const deleteRuntime = {
  generatedAt,
  rolloutMode: 'shadow',
  summary: {
    total: 0,
    open: 0,
    failed: 0,
    statusCounts,
    due: { count: 0, oldestAt: null },
    staleLeases: { count: 0, oldestAt: null },
    ambiguousSends: { count: 0, oldestAt: null },
    giveawayWinnerNotificationDeadEnds: {
      count: 0,
      ambiguous: 0,
      failedTerminal: 0,
      oldestAt: null,
    },
    oldestOpen: { createdAt: null, ageMs: null },
  },
  items: [],
  ambiguousSends: [],
  giveawayWinnerNotificationDeadEnds: [],
};

const port = await getAvailablePort();
const baseUrl = `http://127.0.0.1:${port}/`;
const server = spawn(
  process.execPath,
  [
    path.join(rootDir, 'node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ],
  { cwd: path.join(rootDir, 'apps/admin'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverOutput = '';
server.stdout.on('data', (chunk) => {
  serverOutput += chunk;
});
server.stderr.on('data', (chunk) => {
  serverOutput += chunk;
});

let browser;
try {
  await waitForUrl(baseUrl, server);
  browser = await chromium.launch({ headless: true });
  for (const profile of [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'narrow', viewport: { width: 390, height: 844 } },
  ]) {
    await smokeProfile(browser, profile);
  }
  process.stdout.write('Safety Desk browser smoke passed: desktop, narrow\n');
} finally {
  await browser?.close();
  await stopServer(server);
}

async function smokeProfile(activeBrowser, profile) {
  const context = await activeBrowser.newContext({ viewport: profile.viewport, locale: 'ru-RU' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) =>
    errors.push(`requestfailed: ${request.method()} ${request.url()}`),
  );
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.search.includes(accessCode) || request.postData()?.includes(accessCode)) {
      throw new Error('Access code leaked into URL or request body.');
    }
    if (request.headers()['x-admin-access-code'] !== accessCode) {
      await route.fulfill({ status: 401, json: { message: 'missing access code' } });
      return;
    }
    const payload = url.pathname.endsWith('/safety-desk/queue')
      ? queue
      : url.pathname.endsWith('/support-requests/queue')
        ? supportQueue
        : url.pathname.endsWith('/safety-desk/runtime/deletes')
          ? deleteRuntime
          : null;
    if (!payload) {
      await route.fulfill({ status: 404, json: { message: 'unmocked smoke route' } });
      return;
    }
    await route.fulfill({ status: 200, json: payload });
  });

  const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
  if (!response?.ok()) {
    throw new Error(`${profile.name} failed to load Safety Desk.`);
  }
  await page.getByPlaceholder('Введите код').fill(accessCode);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.getByRole('button', { name: 'Публикации' }).waitFor();
  await page.getByRole('button', { name: 'Обращения' }).click();
  await page.getByRole('button', { name: 'Удаления' }).click();
  await page.getByRole('button', { name: 'Публикации' }).click();

  const state = await page.evaluate(() => ({
    href: window.location.href,
    localStorage: JSON.stringify(window.localStorage),
    sessionStorage: JSON.stringify(window.sessionStorage),
    hasOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  if (`${state.href}${state.localStorage}${state.sessionStorage}`.includes(accessCode)) {
    errors.push('access code leaked into browser URL/storage');
  }
  if (state.hasOverflow) {
    errors.push(`horizontal overflow at ${profile.viewport.width}px`);
  }
  if (errors.length > 0) {
    throw new Error(`${profile.name} Safety Desk smoke failed:\n${errors.join('\n')}`);
  }
  await context.close();
}

function getAvailablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const selectedPort = typeof address === 'object' && address ? address.port : null;
      probe.close((error) => {
        if (error || !selectedPort) {
          reject(error ?? new Error('Could not allocate an admin smoke port.'));
        } else {
          resolvePort(selectedPort);
        }
      });
    });
  });
}

async function waitForUrl(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Safety Desk preview exited early:\n${serverOutput}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Preview startup is expected to refuse connections briefly.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for Safety Desk preview:\n${serverOutput}`);
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}
