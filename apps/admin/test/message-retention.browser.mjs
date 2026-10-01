import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.ADMIN_TEST_BASE_URL ?? 'http://127.0.0.1:5188/admin/';
const date = '2026-10-01T10:00:00.000Z';
const output = await mkdtemp(join(tmpdir(), 'maxim-retention-admin-'));
const browser = await chromium.launch();

function chat(chatId = 'chat/1', overrides = {}) {
  return {
    chatId,
    chatTitle: 'Рабочий чат',
    enabled: true,
    hours: 24,
    revision: 7,
    activationId: 'activation-1',
    pendingCount: 4,
    deletedCount: 20,
    skippedCount: 1,
    status: 'error',
    oldestDueAt: date,
    nextRunAt: date,
    hasTerminalReview: true,
    hasUnresolvedReceipt: true,
    ...overrides,
  };
}

function preview(chatId = 'chat/1', overrides = {}) {
  return {
    chatId,
    revision: 7,
    activationId: 'activation-1',
    items: [
      {
        messageId: 'message/1',
        authorId: 'user-1',
        sourceAt: date,
        dueAt: date,
        status: 'terminal_review',
        outcomeCode: 'worker_error',
        intentId: 'intent-1',
        intentStatus: 'FAILED_TERMINAL',
        intentUpdatedAt: date,
        intentAttemptCount: 3,
        reconcileAfter: null,
        retryAllowed: true,
      },
      {
        messageId: 'message/2',
        authorId: 'user-2',
        sourceAt: date,
        dueAt: date,
        status: 'pending',
        outcomeCode: 'reconciliation',
        intentId: 'intent-2',
        intentStatus: 'AMBIGUOUS',
        intentUpdatedAt: date,
        intentAttemptCount: 2,
        reconcileAfter: date,
        retryAllowed: false,
      },
    ],
    ...overrides,
  };
}

function deletion(id, overrides = {}) {
  return {
    id,
    chatId: 'chat-1',
    chatTitle: id,
    messageId: id,
    subjectUserId: null,
    entityType: 'CHAT',
    originBotId: null,
    routingPolicy: 'delete_capable',
    effectiveRoutingPolicy: 'delete_capable',
    crossBotEnabled: false,
    routingState: 'READY',
    rollout: 'execute',
    status: 'FAILED_TERMINAL',
    ageMs: 1_000,
    attemptCount: 3,
    executeAt: date,
    nextAttemptAt: date,
    retryUntilAt: date,
    firstAttemptAt: date,
    lastAttemptAt: date,
    completedAt: date,
    leaseExpiresAt: null,
    deleteDispatchStartedAt: null,
    deleteDispatchStartedBotId: null,
    remoteDeleteSucceededAt: null,
    remoteDeleteSucceededBotId: null,
    createdAt: date,
    updatedAt: date,
    lastBotId: null,
    succeededBotId: null,
    lastStatusCode: null,
    lastErrorCode: 'worker_error',
    lastError: null,
    capability: {
      confirmed: true,
      activeMembershipCount: 1,
      confirmedBotIds: ['bot-1'],
      memberships: [],
    },
    reasons: [],
    ...overrides,
  };
}

async function fixture(viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const state = {
    rows: [chat(), chat('chat-2', { chatTitle: 'Отключённый чат', enabled: false, status: 'off' })],
    nextAfter: null,
    runtimeStatus: 200,
    previewStatus: 200,
    postStatus: 200,
    losePost: false,
    previewData: preview(),
    postData: preview('chat/1', { items: [] }),
    runtimeGate: null,
    postGate: null,
    slowPreview: null,
    requests: [],
    posts: [],
    commercialItem: null,
    commercialPosts: [],
    ordinary: [
      deletion('retention-owned', { retentionOwned: true, retryAllowed: true }),
      deletion('old-server'),
      deletion('permitted', { retentionOwned: false, retryAllowed: true }),
    ],
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    state.requests.push(url.pathname + url.search);
    const respond = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/v1/safety-desk/runtime/retention') {
      if (state.runtimeGate) await state.runtimeGate;
      return respond(
        state.runtimeStatus === 200
          ? {
              generatedAt: date,
              mode: 'on',
              nextAfter: state.nextAfter,
              quotas: [{ shard: 0, pendingCount: 4, cap: 100 }],
              items: state.rows,
            }
          : { message: 'Нет доступа к очистке' },
        state.runtimeStatus,
      );
    }
    if (url.pathname === '/api/v1/safety-desk/commercial/review') {
      return respond({
        generatedAt: date,
        items: state.commercialItem ? [state.commercialItem] : [],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith('/label')) {
      const body = request.postDataJSON();
      state.commercialPosts.push(body);
      state.commercialItem = {
        ...state.commercialItem,
        label: body.label,
        reviewReason: body.reason,
        reviewedAt: date,
      };
      return respond(state.commercialItem);
    }
    if (url.pathname.endsWith('/preview')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      const data = { ...state.previewData, chatId: id };
      if (state.slowPreview?.chatId === id) await state.slowPreview.promise;
      return respond(
        state.previewStatus === 200 ? data : { message: 'Диагностика недоступна' },
        state.previewStatus,
      );
    }
    if (url.pathname.endsWith('/retry')) {
      state.posts.push({ path: url.pathname, body: request.postDataJSON() });
      if (state.postGate) await state.postGate;
      if (state.losePost) return route.abort('failed');
      return respond(
        state.postStatus === 200 ? state.postData : { message: 'Версия изменилась' },
        state.postStatus,
      );
    }
    if (url.pathname === '/api/v1/safety-desk/runtime/deletes') {
      return respond({
        generatedAt: date,
        rolloutMode: 'on',
        items: state.ordinary,
        summary: {
          total: 3,
          open: 0,
          failed: 3,
          statusCounts: Object.fromEntries(
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
            ].map((status) => [status, status === 'FAILED_TERMINAL' ? 3 : 0]),
          ),
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
      });
    }
    return respond({ generatedAt: date, summary: {}, items: [] });
  });
  await page.goto(base);
  await page.getByLabel('Код доступа').fill('admin-test-access');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('button', { name: 'Очистка', exact: true }).waitFor();
  return { context, page, state, errors };
}

async function openRetention(page) {
  await page.getByRole('button', { name: 'Очистка', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить', exact: true }).first().waitFor();
}

async function openPreview(page, index = 0) {
  await page.getByRole('button', { name: 'Проверить', exact: true }).nth(index).click();
  await page.getByText('Ревизия 7 · запуск activation-1', { exact: true }).waitFor();
}

async function mountStateFixture(page) {
  await page.evaluate(async () => {
    const fixture = await import('/admin/test/retention-state-fixture.mjs');
    fixture.mountRetentionStateFixture();
  });
  await page.waitForFunction(() => window.__retentionStateFixture?.desk?.runtime?.items.length);
  await page.evaluate(() => {
    const desk = window.__retentionStateFixture.desk;
    void desk.loadPreview(desk.runtime.items[0]);
  });
  await page.waitForFunction(() => window.__retentionStateFixture.desk.preview?.items.length);
}

async function waitForPosts(page, state, count) {
  for (let attempt = 0; attempt < 80 && state.posts.length < count; attempt += 1) {
    await page.waitForTimeout(25);
  }
  assert.equal(state.posts.length, count);
}

try {
  {
    const { context, page, state, errors } = await fixture();
    const moduleUrl = (url) => url.pathname.endsWith('/src/retention-desk.tsx');
    await page.route(moduleUrl, (route) => route.abort('failed'));
    await page.getByRole('button', { name: 'Очистка', exact: true }).click();
    await page.getByRole('heading', { name: 'Не удалось открыть очистку', exact: true }).waitFor();
    assert.equal(
      state.requests.some((path) => path.includes('/retention')),
      false,
    );
    await page.getByRole('button', { name: 'Коммерческий фильтр', exact: true }).click();
    await page
      .getByText('Образцов пока нет. Здесь появятся спорные сообщения и подтверждённые удаления.', {
        exact: true,
      })
      .waitFor();
    await page.getByRole('button', { name: 'Очистка', exact: true }).click();
    await page.getByRole('heading', { name: 'Не удалось открыть очистку', exact: true }).waitFor();
    await page.unroute(moduleUrl);
    await page.getByRole('button', { name: 'Перезагрузить Safety Desk', exact: true }).click();
    await page.getByLabel('Код доступа').waitFor();
    await page.getByLabel('Код доступа').fill('admin-test-access');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await openRetention(page);
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write('PASS failed lazy module preserves Safety Desk and reload recovers\n');
  }
  {
    const { context, page, state, errors } = await fixture();
    assert.equal(
      state.requests.some((path) => path.includes('/retention')),
      false,
    );
    let release;
    state.runtimeGate = new Promise((resolve) => {
      release = resolve;
    });
    await page.getByRole('button', { name: 'Очистка', exact: true }).click();
    await page.getByText('Загружаю чаты…', { exact: true }).waitFor();
    release();
    await page.getByRole('button', { name: 'Проверить', exact: true }).first().waitFor();
    assert.equal(
      state.requests.some((path) => path.endsWith('/preview')),
      false,
    );
    await openPreview(page);
    assert.equal(
      await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).count(),
      1,
    );
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    assert.equal(state.posts.length, 0);
    let releasePost;
    state.postGate = new Promise((resolve) => {
      releasePost = resolve;
    });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    await page.getByRole('button', { name: 'Возвращаю…', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Удаления', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Коммерческий фильтр', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Возвращаю…', exact: true }).isDisabled(),
      true,
    );
    releasePost();
    await page
      .getByText('Сообщение возвращено в очередь. Результат проверит фоновая очистка.', {
        exact: true,
      })
      .waitFor();
    assert.equal(state.posts.length, 1);
    assert.deepEqual(state.posts[0].body, {
      messageId: 'message/1',
      activationId: 'activation-1',
      expectedRevision: 7,
      intentId: 'intent-1',
      expectedIntentUpdatedAt: date,
      expectedAttemptCount: 3,
    });
    await openPreview(page, 1);
    await page.getByText('Очистка выключена. Повтор недоступен.', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).count(),
      0,
    );
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write(
      'PASS lazy diagnostics, disabled policy, confirmed retry and duplicate guard\n',
    );
  }
  {
    const { context, page, state } = await fixture();
    await openRetention(page);
    await openPreview(page);
    state.postStatus = 409;
    state.previewData = preview('chat/1', {
      revision: 8,
      items: [{ ...preview().items[0], intentAttemptCount: 4 }],
    });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    await page.getByText('Ревизия 8 · запуск activation-1', { exact: true }).waitFor();
    await page
      .getByText(
        'Повтор отклонён: Версия изменилась. Диагностика обновлена; проверьте запись перед повтором.',
        {
          exact: true,
        },
      )
      .waitFor();
    state.postStatus = 200;
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    await page
      .getByText('Сообщение возвращено в очередь. Результат проверит фоновая очистка.', {
        exact: true,
      })
      .waitFor();
    assert.equal(state.posts.length, 2);
    assert.equal(state.posts[1].body.expectedRevision, 8);
    assert.equal(state.posts[1].body.expectedAttemptCount, 4);
    await context.close();
    process.stdout.write('PASS conflict reload and new exact version\n');
  }
  {
    const { context, page, state } = await fixture();
    await openRetention(page);
    await openPreview(page);
    state.losePost = true;
    state.previewStatus = 503;
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    await page.getByText(/Обновите диагностику перед повтором\./).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).count(),
      0,
    );
    assert.equal(state.posts.length, 1);
    state.previewStatus = 200;
    state.previewData = preview('chat/1', { items: [] });
    await page.getByRole('button', { name: 'Обновить диагностику', exact: true }).click();
    await page.getByText('Сообщений, требующих проверки, нет.', { exact: true }).waitFor();
    assert.equal(state.posts.length, 1);
    await context.close();
    process.stdout.write('PASS lost reply with failed reconciliation, no blind retry\n');
  }
  {
    const { context, page, state } = await fixture();
    state.nextAfter = 'cursor/chat?next=1';
    await openRetention(page);
    await openPreview(page);
    state.rows = [];
    state.nextAfter = null;
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await page.getByText('Чатов с настройкой очистки пока нет.', { exact: true }).waitFor();
    assert.equal(
      state.requests.includes(
        '/api/v1/safety-desk/runtime/retention?after=cursor%2Fchat%3Fnext%3D1',
      ),
      true,
    );
    assert.equal(
      await page.getByRole('region', { name: 'Диагностика очистки', exact: true }).count(),
      0,
    );
    state.rows = [chat()];
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await page.getByRole('button', { name: 'Проверить', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
    await context.close();
    process.stdout.write('PASS bounded pagination and selection reset\n');
  }
  {
    const { context, page, state, errors } = await fixture();
    const runtimePath = '/api/v1/safety-desk/runtime/retention';
    const latestPageRequest = () =>
      state.requests.filter((path) => path.split('?')[0] === runtimePath).at(-1);
    state.nextAfter = 'cursor/page2';
    await openRetention(page);
    state.runtimeStatus = 503;
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await page.getByText('Нет доступа к очистке', { exact: true }).waitFor();
    assert.equal(latestPageRequest(), `${runtimePath}?after=cursor%2Fpage2`);
    state.runtimeStatus = 200;
    state.rows = [chat('chat-page2', { chatTitle: 'Вторая страница' })];
    state.nextAfter = null;
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await page.getByText('Вторая страница', { exact: true }).waitFor();
    assert.equal(latestPageRequest(), `${runtimePath}?after=cursor%2Fpage2`);
    assert.equal(
      await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(),
      false,
    );
    state.runtimeStatus = 503;
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await page.getByText('Нет доступа к очистке', { exact: true }).waitFor();
    assert.equal(latestPageRequest(), runtimePath);
    state.runtimeStatus = 200;
    state.rows = [chat('chat-page1', { chatTitle: 'Первая страница' })];
    state.nextAfter = 'cursor/page2';
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await page.getByText('Первая страница', { exact: true }).waitFor();
    assert.equal(latestPageRequest(), runtimePath);
    assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
    state.rows = [chat('chat-page2', { chatTitle: 'Вторая страница' })];
    state.nextAfter = null;
    await page.getByRole('button', { name: 'Далее', exact: true }).click();
    await page.getByText('Вторая страница', { exact: true }).waitFor();
    state.rows = [chat('chat-page1', { chatTitle: 'Первая страница' })];
    await page.getByRole('button', { name: 'Назад', exact: true }).click();
    await page.getByText('Первая страница', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Назад', exact: true }).isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write('PASS failed Next and Back retry their intended cursor and page trail\n');
  }
  {
    const { context, page, state } = await fixture();
    state.runtimeStatus = 403;
    await page.getByRole('button', { name: 'Очистка', exact: true }).click();
    await page.getByText('Нет доступа к очистке', { exact: true }).waitFor();
    state.runtimeStatus = 200;
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await page.getByRole('button', { name: 'Проверить', exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Удаления', exact: true }).click();
    await page.getByRole('button', { name: 'Ошибки', exact: true }).click();
    await page
      .getByText('Диагностика и безопасный повтор доступны в разделе «Очистка».', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Повторить удаление', exact: true }).count(),
      0,
    );
    await page.locator('.delete-queue-item').filter({ hasText: 'old-server' }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Повторить удаление', exact: true }).count(),
      0,
    );
    await page.locator('.delete-queue-item').filter({ hasText: 'permitted' }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Повторить удаление', exact: true }).count(),
      1,
    );
    await context.close();
    process.stdout.write('PASS denied state and ordinary retention/legacy retry isolation\n');
  }
  {
    const { context, page, state } = await fixture();
    state.rows[1].enabled = true;
    await openRetention(page);
    let release;
    state.slowPreview = {
      chatId: 'chat/1',
      promise: new Promise((resolve) => {
        release = resolve;
      }),
    };
    await page.getByRole('button', { name: 'Проверить', exact: true }).first().click();
    await page.getByText('Загружаю диагностику…', { exact: true }).waitFor();
    await openPreview(page, 1);
    release();
    await page.waitForTimeout(100);
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).click();
    await page
      .getByText('Сообщение возвращено в очередь. Результат проверит фоновая очистка.', {
        exact: true,
      })
      .waitFor();
    assert.equal(state.posts[0].path, '/api/v1/safety-desk/runtime/retention/chat-2/retry');
    await context.close();
    process.stdout.write('PASS stale preview discarded after chat switch\n');
  }
  {
    const { context, page, state, errors } = await fixture();
    state.commercialItem = {
      id: 'commercial-1',
      chatId: 'chat-3',
      chatTitle: 'Образец коммерческого фильтра',
      source: 'TEXT',
      excerpt: 'Спорное сообщение',
      score: 65,
      actionBand: 'review',
      messageDisposition: 'KEEP',
      requiredPolicyCohorts: [],
      detectorVersion: 'test',
      decisionFingerprint: 'sample-fingerprint',
      reviewPriority: 50,
      reasons: [],
      label: null,
      reviewReason: '',
      reviewedAt: null,
      observedAt: date,
      expiresAt: date,
      updatedAt: date,
    };
    await openRetention(page);
    await openPreview(page);
    await page.getByRole('button', { name: 'Коммерческий фильтр', exact: true }).click();
    await page.getByRole('article', { name: 'Оценка образца' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Экспорт', exact: true }).count(), 0);
    await page.getByLabel('Комментарий к оценке').fill('Проверено после объединения');
    await page.getByRole('button', { name: 'Не реклама', exact: true }).click();
    await page.getByText('Сохранено: Не реклама', { exact: true }).waitFor();
    assert.deepEqual(state.commercialPosts, [
      { expectedUpdatedAt: date, label: 'NOT_COMMERCIAL', reason: 'Проверено после объединения' },
    ]);
    assert.equal(state.posts.length, 0);
    await openRetention(page);
    await openPreview(page);
    assert.equal(
      await page.getByRole('button', { name: 'Вернуть в очередь', exact: true }).count(),
      1,
    );
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write(
      'PASS Commercial Review and retention survive tab switching and independent actions\n',
    );
  }
  {
    const { context, page, state, errors } = await fixture();
    await mountStateFixture(page);
    let releaseOld;
    state.postGate = new Promise((resolve) => {
      releaseOld = resolve;
    });
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      void desk.retry(desk.preview.items[0]);
    });
    await waitForPosts(page, state, 1);
    await page.evaluate(() => window.__retentionStateFixture.setVisible(false));
    await page.locator('#retention-fixture-preview').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#retention-fixture-busy').textContent(), 'idle');
    await page.evaluate(() => window.__retentionStateFixture.setVisible(true));
    await page.locator('#retention-fixture-preview').waitFor({ state: 'attached' });
    await page.waitForFunction(() => window.__retentionStateFixture.desk.runtime?.items.length);
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      void desk.loadPreview(desk.runtime.items[0]);
    });
    await page.waitForFunction(() => window.__retentionStateFixture.desk.preview?.items.length);
    let releaseNew;
    state.postGate = new Promise((resolve) => {
      releaseNew = resolve;
    });
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      void desk.retry(desk.preview.items[0]);
    });
    await waitForPosts(page, state, 2);
    releaseOld();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#retention-fixture-busy').textContent(), 'busy');
    assert.equal(
      await page.locator('#retention-fixture-preview').textContent(),
      'Возвращаю сообщение в очередь…',
    );
    assert.equal(
      await page.evaluate(() => window.__retentionStateFixture.desk.preview.items.length),
      2,
    );
    releaseNew();
    await page.waitForFunction(() => window.__retentionStateFixture.controls.busy === false);
    assert.equal(
      await page.locator('#retention-fixture-preview').textContent(),
      'Сообщение возвращено в очередь. Результат проверит фоновая очистка.',
    );
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write('PASS old unmounted POST cannot release or update a new desk retry\n');
  }
  {
    const { context, page, state, errors } = await fixture();
    await mountStateFixture(page);
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      window.__retentionStateFixture.stale = { retry: desk.retry, item: desk.preview.items[0] };
    });
    let releasePreview;
    state.slowPreview = {
      chatId: 'chat/1',
      promise: new Promise((resolve) => {
        releasePreview = resolve;
      }),
    };
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      void desk.loadPreview(desk.runtime.items[0]);
    });
    await page.waitForFunction(() => window.__retentionStateFixture.desk.previewLoading);
    await page.evaluate(() => window.__retentionStateFixture.controls.refresh());
    await page.waitForFunction(
      () =>
        !window.__retentionStateFixture.desk.loading &&
        !window.__retentionStateFixture.desk.previewLoading,
    );
    releasePreview();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.__retentionStateFixture.desk.preview), null);
    state.slowPreview = null;
    state.previewData = preview('chat/1', {
      revision: 8,
      items: [{ ...preview().items[0], retryAllowed: false, intentAttemptCount: 4 }],
    });
    await page.evaluate(() => {
      const desk = window.__retentionStateFixture.desk;
      void desk.loadPreview(desk.runtime.items[0]);
    });
    await page.waitForFunction(() => window.__retentionStateFixture.desk.preview?.revision === 8);
    await page.evaluate(() => {
      const stale = window.__retentionStateFixture.stale;
      void stale.retry(stale.item);
    });
    await page.waitForTimeout(100);
    assert.equal(state.posts.length, 0);
    assert.deepEqual(errors, []);
    await context.close();
    process.stdout.write(
      'PASS page refresh discards late preview and stale retry uses current permission\n',
    );
  }
  for (const width of [1440, 1024, 900, 768, 390, 320]) {
    const { context, page, state, errors } = await fixture({
      width,
      height: width === 1440 ? 900 : 844,
    });
    state.rows[0].chatTitle = 'Длинное название рабочего чата для проверки таблицы';
    await openRetention(page);
    await openPreview(page);
    const layout = await page.evaluate(() => ({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      deskWidth: document.querySelector('.retention-desk').getBoundingClientRect().width,
      retryClipped: [...document.querySelectorAll('.retention-candidate button')].some(
        (button) => button.scrollWidth > button.clientWidth + 2,
      ),
    }));
    assert.ok(layout.documentWidth <= layout.viewport + 2, JSON.stringify(layout));
    assert.ok(layout.deskWidth <= layout.viewport + 2, JSON.stringify(layout));
    assert.equal(layout.retryClipped, false);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(output, `retention-${width}.png`), fullPage: true });
    await context.close();
    process.stdout.write(`PASS retention layout ${width}px\n`);
  }
  process.stdout.write(`Screenshots: ${output}\n`);
} finally {
  await browser.close();
  if (process.env.ADMIN_TEST_KEEP_ARTIFACTS !== '1')
    await rm(output, { recursive: true, force: true });
}
