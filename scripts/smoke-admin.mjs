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
const deleteItems = ['a', 'b'].map((key, index) => ({
  id: `smoke-delete-${key}`,
  chatId: `smoke-chat-${key}`,
  chatTitle: `Тест удаления ${key.toUpperCase()}`,
  messageId: `smoke-message-${key}`,
  subjectUserId: null,
  entityType: 'CHAT',
  originBotId: null,
  routingPolicy: 'origin_only',
  effectiveRoutingPolicy: 'origin_only',
  crossBotEnabled: false,
  routingState: 'NO_ELIGIBLE_BOT',
  rollout: 'execute',
  retentionOwned: false,
  retryAllowed: index === 1,
  status: index === 0 ? 'AMBIGUOUS' : 'FAILED_TERMINAL',
  ageMs: 1_000,
  attemptCount: 1,
  executeAt: generatedAt,
  nextAttemptAt: generatedAt,
  retryUntilAt: '2026-07-19T00:05:00.000Z',
  firstAttemptAt: generatedAt,
  lastAttemptAt: generatedAt,
  completedAt: null,
  leaseExpiresAt: null,
  deleteDispatchStartedAt: index === 0 ? generatedAt : null,
  deleteDispatchStartedBotId: null,
  remoteDeleteSucceededAt: null,
  remoteDeleteSucceededBotId: null,
  createdAt: generatedAt,
  updatedAt: generatedAt,
  lastBotId: null,
  succeededBotId: null,
  lastStatusCode: null,
  lastErrorCode: null,
  lastError: null,
  capability: { confirmed: false, activeMembershipCount: 0, confirmedBotIds: [], memberships: [] },
  reasons: [],
}));
const deleteRuntime = {
  generatedAt,
  rolloutMode: 'shadow',
  summary: {
    total: 2,
    open: 1,
    failed: 1,
    statusCounts: { ...statusCounts, AMBIGUOUS: 1, FAILED_TERMINAL: 1 },
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
  items: deleteItems,
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
  let cohortRequests = 0;
  let cohortUnavailable = false;
  let publicationRequests = 0;
  let evidenceRequests = 0;
  let evidenceMalformed = false;
  const cohort = {
    schemaVersion: 1,
    basis: 'receipt_created_at',
    windowSeconds: 30,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:00:30.000Z',
    observedAt: '2026-10-16T18:01:00.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 0,
    effectsEvidence: 'not_linked',
    rows: [
      'RECEIVED',
      'QUEUED',
      'PROCESSED',
      'DUPLICATE',
      'FAILED',
      'NO_REPLAY_HELD',
      'CANCELLED',
      'QUARANTINED',
    ].map((status) => ({
      status,
      countLowerBound: 0,
      truncated: false,
      oldestPendingAgeSec: null,
      expiredAtObservation: 0,
      quarantineTimestampPresent: 0,
      invalidProcessedClocks: 0,
      invalidQueuedClocks: 0,
      processedLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
      enqueueLatency: { sampleCount: 0, p95Ms: null, p99Ms: null },
    })),
  };
  const publicationCohort = {
    schemaVersion: 1,
    basis: 'occurrence_created_at',
    dispatchProfile: 'PUBLIK_V1',
    windowSeconds: 900,
    graceSeconds: 30,
    windowStartedAt: '2026-10-16T18:00:00.000Z',
    windowEndedAt: '2026-10-16T18:15:00.000Z',
    observedAt: '2026-10-16T18:15:30.000Z',
    sampleLimitPerStatus: 512,
    sampleComplete: true,
    totalCountLowerBound: 1,
    completionTimingEvidence: 'not_recorded',
    effectsEvidence: 'occurrence_status_only',
    rows: ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'].map(
      (status) => ({
        status,
        countLowerBound: status === 'AMBIGUOUS' ? 1 : 0,
        truncated: false,
        pendingNotDue: 0,
        pendingDue: 0,
        pendingExpired: 0,
        pendingTimingUnknown: 0,
        blockedPending: 0,
        retryAuthorizedCount: 0,
        oldestDueAgeSec: null,
        modeCounts: {
          NOW: status === 'AMBIGUOUS' ? 1 : 0,
          ONCE: 0,
          SLOTS: 0,
          RECURRENCE: 0,
          UNKNOWN: 0,
        },
        mediaCounts: { TEXT: 0, IMAGE: 0, VIDEO: 0, UNKNOWN: status === 'AMBIGUOUS' ? 1 : 0 },
      }),
    ),
  };
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (
        cohortUnavailable &&
        ['webhook-cohort', 'publication-cohort'].some(
          (endpoint) =>
            message.location().url === `${baseUrl}api/v1/safety-desk/runtime/${endpoint}`,
        ) &&
        /^Failed to load resource: the server responded with a status of 503\b/.test(message.text())
      )
        return;
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
    if (url.pathname.endsWith('/safety-desk/runtime/webhook-cohort')) {
      cohortRequests += 1;
      await route.fulfill(
        cohortUnavailable
          ? { status: 503, json: { message: 'Сводка обработки временно недоступна.' } }
          : { status: 200, json: cohort },
      );
      return;
    }
    if (url.pathname.endsWith('/safety-desk/runtime/publication-cohort')) {
      if (request.method() !== 'GET') throw new Error('Publication cohort attempted a mutation.');
      publicationRequests += 1;
      await route.fulfill(
        cohortUnavailable
          ? { status: 503, json: { message: 'Publication observations unavailable' } }
          : { status: 200, json: publicationCohort },
      );
      return;
    }
    const evidenceItem = deleteItems.find((item) =>
      url.pathname.endsWith(`/safety-desk/runtime/deletes/${item.id}/evidence`),
    );
    if (evidenceItem) {
      if (request.method() !== 'GET') throw new Error('Delete evidence attempted a mutation.');
      evidenceRequests += 1;
      await route.fulfill({
        status: 200,
        json: evidenceMalformed
          ? { version: 0 }
          : {
              version: 1,
              observedAt: generatedAt,
              intentId: evidenceItem.id,
              webhookLink: 'not_recorded',
              originCoverage: 'partial',
              deletion: {
                status: evidenceItem.status,
                outcome: 'unknown',
                createdAt: generatedAt,
                sourceMessageAt: null,
                firstAttemptAt: generatedAt,
                dispatchStartedAt: generatedAt,
                acknowledgedAt: null,
                completedAt: null,
              },
              reasons: {
                sampleComplete: true,
                items: [
                  {
                    reasonKey: 'SMOKE_DELETE',
                    ruleCode: 'SMOKE_DELETE',
                    moderationEventId: null,
                    decisionRecorded: false,
                    origin: {
                      state: 'linked',
                      webhookEventId: 'smoke-receipt',
                      receivingBotId: 'smoke-receiver',
                      executionBotId: 'smoke-executor',
                      eventAt: generatedAt,
                      acceptedAt: generatedAt,
                      recordedAt: generatedAt,
                      evidenceVersion: 1,
                    },
                  },
                ],
              },
              followups: {
                sampleComplete: true,
                items: [
                  {
                    id: 'smoke-followup',
                    ruleCode: 'SMOKE_DELETE',
                    status: 'IN_PROGRESS',
                    sourceAt: generatedAt,
                    deadlineAt: '2026-07-19T00:05:00.000Z',
                    completedAt: null,
                    decisionRecorded: false,
                    explanation: { state: 'unknown', completedAt: null, remoteMessageId: null },
                    sanctionNotice: {
                      state: 'not_recorded',
                      completedAt: null,
                      remoteMessageId: null,
                    },
                  },
                ],
              },
            },
      });
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
  const evidencePanel = page.getByRole('region', { name: 'Подтверждения результата' });
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).waitFor();
  if (evidenceRequests !== 0)
    throw new Error('Delete evidence loaded without an explicit request.');
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).click();
  await evidencePanel.getByText('Исход удаления неизвестен', { exact: true }).waitFor();
  await evidencePanel
    .getByText('Объяснение: Исход отправки неизвестен', { exact: false })
    .waitFor();
  await evidencePanel
    .getByText('Исходное событие и исполнитель подтверждены.', { exact: false })
    .waitFor();
  if (evidenceRequests !== 1) throw new Error('Delete evidence request was repeated.');
  if (await page.getByRole('button', { name: 'Повторить удаление', exact: true }).count()) {
    throw new Error('Unknown delete result exposed a retry action.');
  }
  if (await evidencePanel.getByRole('button', { name: /повтор|отправить|публиковать/i }).count()) {
    throw new Error('Delete evidence panel exposed an effect action.');
  }
  await page.getByRole('button', { name: 'Все', exact: true }).click();
  await page.getByRole('button', { name: /Тест удаления B/ }).click();
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).waitFor();
  if (await evidencePanel.getByText('Исход удаления неизвестен', { exact: true }).count()) {
    throw new Error('Evidence from a previous delete remained visible after selection changed.');
  }
  if (evidenceRequests !== 1)
    throw new Error('Selecting another delete fetched evidence automatically.');
  await page.getByRole('button', { name: 'Повторить удаление', exact: true }).waitFor();
  evidenceMalformed = true;
  await evidencePanel.getByRole('button', { name: 'Проверить подтверждения' }).click();
  await evidencePanel
    .getByRole('alert')
    .filter({ hasText: 'Не удалось загрузить подтверждения.' })
    .waitFor();
  if (evidenceRequests !== 2) throw new Error('Failed evidence read was retried automatically.');
  await page.getByRole('button', { name: 'Повторить удаление', exact: true }).waitFor();
  if (cohortRequests !== 0 || publicationRequests !== 0)
    throw new Error('Closed cohort loaded before its view was opened.');
  await page.getByRole('button', { name: 'Наблюдения' }).click();
  await page.getByText('За этот интервал события не наблюдались.', { exact: false }).waitFor();
  await page.getByText('Обработка события не подтверждает удаление', { exact: false }).waitFor();
  await page.getByText(/21:00:00 МСК — .*21:00:30 МСК/).waitFor();
  const publicationPanel = page.getByRole('region', { name: 'Результаты запусков Публика' });
  await publicationPanel.getByText('Исход неизвестен', { exact: true }).first().waitFor();
  await publicationPanel
    .getByText('Поздний ручной повтор отдельно не учитывается.', { exact: false })
    .waitFor();
  await publicationPanel.getByText('Режимы и содержимое запусков', { exact: true }).click();
  await publicationPanel.getByRole('columnheader', { name: 'Содержимое неизвестно' }).waitFor();
  if (publicationRequests !== 1) throw new Error('Publication cohort request repeated.');
  cohort.sampleComplete = false;
  cohort.totalCountLowerBound = 512;
  cohort.rows[2].countLowerBound = 512;
  cohort.rows[2].truncated = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByText('Неполная выборка: достигнут предел чтения', { exact: false }).waitFor();
  cohortUnavailable = true;
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'последний успешный снимок' }).waitFor();
  await publicationPanel
    .getByRole('alert')
    .filter({ hasText: 'Не удалось проверить запуски Публика.' })
    .waitFor();
  if (await publicationPanel.getByRole('table').count())
    throw new Error('Failed publication refresh retained stale success.');
  if (await page.getByRole('button', { name: /повтор|публиковать/i }).count()) {
    throw new Error('Read-only cohort exposed an effect retry action.');
  }
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) {
    throw new Error(`${profile.name} cohort view has horizontal overflow.`);
  }
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
