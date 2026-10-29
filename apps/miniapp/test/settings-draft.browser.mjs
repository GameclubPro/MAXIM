import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/settings-draft-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
    window.__vite_plugin_react_preamble_installed__=true;
    await import('/app/test/fixtures/settings-draft-harness.tsx');
  </script></body></html>`,
    }),
  );
  let pending = [];
  let serverSettings;
  let pendingRefresh;
  let delayRefresh = false;
  let failRefresh = false;
  let pendingStop = [];
  let ordinaryWrites = [];
  let holdOrdinary = false;
  let pendingOrdinary;
  await page.route('**/api/chats/*/settings', (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      ordinaryWrites.push(body);
      const saved = { ...serverSettings, ...body, settingsRevision: '2026-10-03T00:04:00.000Z' };
      if (holdOrdinary) {
        pendingOrdinary = { route, saved };
        return;
      }
      serverSettings = saved;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(serverSettings),
      });
    }
    if (delayRefresh) {
      pendingRefresh = route;
      return;
    }
    if (failRefresh) return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(serverSettings) });
  });
  await page.route('**/api/chats/*/settings/section', (route) => {
    pending.push(route);
  });
  await page.route('**/api/chats/*/stop-words', (route) => {
    if (route.request().method() === 'PUT') {
      pendingStop.push(route);
      return;
    }
    return route.fulfill({
      json: {
        policy: serverSettings.stopWordsPolicy,
        revision: serverSettings.stopWordsRevision,
        settingsRevision: serverSettings.settingsRevision,
        imageScanStatus: 'shadow',
        storageStatus: 'valid',
      },
    });
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const fresh = async () => {
    pending = [];
    pendingRefresh = undefined;
    delayRefresh = false;
    failRefresh = false;
    pendingStop = [];
    ordinaryWrites = [];
    holdOrdinary = false;
    pendingOrdinary = undefined;
    await page.goto(`${base}settings-draft-test`);
    await page.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
    await page.waitForFunction(() =>
      Boolean(JSON.parse(document.querySelector('[data-testid="state"]').textContent).draft),
    );
    serverSettings = (await read()).draft;
  };
  const save = async () => {
    const outgoing = page.waitForRequest('**/api/chats/*/settings/section');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const request = await outgoing;
    const body = request.postDataJSON();
    assert.equal(new URL(request.url()).pathname, '/api/chats/chat-a/settings/section');
    assert.equal(request.method(), 'PATCH');
    assert.equal(body.section, 'limits');
    assert.equal(body.expectedRevision, serverSettings.settingsRevision);
    assert.equal(body.changes.antiSpamEnabled, true);
    assert.equal(Object.hasOwn(body.changes, 'nightModeStartTimeMinutes'), false);
  };
  const reply = async (status = 200) => {
    assert.equal(pending.length, 1);
    const body =
      status === 200
        ? {
            ...serverSettings,
            ...pending[0].request().postDataJSON().changes,
            settingsRevision: '2026-10-03T00:01:00.000Z',
          }
        : { code: status === 409 ? 'CHAT_SETTINGS_CONCURRENT_UPDATE' : 'SAVE_FAILED' };
    const received = page.waitForResponse('**/api/chats/*/settings/section');
    await pending[0].fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
    await received;
  };
  const waitEvent = async (event) =>
    page.waitForFunction(
      (value) =>
        JSON.parse(document.querySelector('[data-testid="state"]').textContent).events.includes(
          value,
        ),
      event,
    );
  const startStopSave = async (workspace = false) => {
    const outgoing = page.waitForRequest('**/api/chats/*/stop-words');
    await page
      .getByRole('button', {
        name: workspace ? 'Сохранить всё' : 'Сохранить стоп-слова',
        exact: true,
      })
      .click();
    const request = await outgoing;
    assert.equal(request.method(), 'PUT');
    assert.equal(request.postDataJSON().expectedRevision, 7);
    return request.postDataJSON();
  };
  const replyStop = async (status = 200, freshChanges = {}) => {
    assert.equal(pendingStop.length, 1);
    const route = pendingStop.shift();
    const request = route.request().postDataJSON();
    const savedRevision = '2026-10-03T00:05:00.000Z';
    if (status === 200)
      serverSettings = {
        ...serverSettings,
        stopWordsPolicy: request.policy,
        stopWordsRevision: request.expectedRevision + 1,
        settingsRevision: savedRevision,
        ...freshChanges,
      };
    const response = page.waitForResponse('**/api/chats/*/stop-words');
    await route.fulfill({
      status,
      json:
        status === 200
          ? {
              policy: request.policy,
              revision: request.expectedRevision + 1,
              settingsRevision: savedRevision,
              imageScanStatus: 'shadow',
              storageStatus: 'valid',
            }
          : { code: status === 409 ? 'STOP_WORDS_REVISION_CONFLICT' : 'SAVE_FAILED' },
    });
    await response;
  };

  await fresh();
  await page.getByLabel('Антиспам', { exact: true }).check();
  await save();
  await page.getByLabel('Лимит', { exact: true }).fill('800');
  await page.getByLabel('Порог сообщений', { exact: true }).fill('9');
  await reply();
  await waitEvent('saved');
  assert.equal((await read()).draft.nightModeStartTimeMinutes, 800);
  assert.equal((await read()).draft.messageCountLimitMessages, 9);
  assert.equal((await read()).dirty, true);
  console.log('PASS: section request and edits made during save');

  for (const status of [500, 409]) {
    await fresh();
    await page.getByLabel('Антиспам', { exact: true }).check();
    await save();
    await page.getByLabel('Порог сообщений', { exact: true }).fill('8');
    const draft = (await read()).draft;
    serverSettings = { ...serverSettings, settingsRevision: '2026-10-03T00:02:00.000Z' };
    await reply(status);
    await waitEvent('error');
    assert.deepEqual((await read()).draft, draft);
    if (status === 409) assert.deepEqual((await read()).conflict.draft, draft);
  }
  console.log('PASS: failed saves and version conflicts retain the latest draft');

  for (const status of [200, 500, 409]) {
    await fresh();
    await page.getByLabel('Антиспам', { exact: true }).check();
    await save();
    await page.getByRole('button', { name: 'Другой чат' }).click();
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector('[data-testid="state"]').textContent).chatId === 'chat-b',
    );
    await page.getByLabel('Лимит', { exact: true }).fill('900');
    const before = await read();
    await reply(status);
    await page.waitForTimeout(100);
    assert.deepEqual(await read(), before);
  }
  console.log('PASS: old chat success, failure and conflict cannot modify a new chat');

  await fresh();
  await page.getByLabel('Антиспам', { exact: true }).check();
  await save();
  await page.getByRole('button', { name: 'Другой чат' }).click();
  await page.getByRole('button', { name: 'Другой чат' }).click();
  await page.getByLabel('Лимит', { exact: true }).fill('650');
  const revisited = (await read()).draft;
  await reply();
  await page.waitForTimeout(100);
  assert.deepEqual((await read()).draft, revisited);
  assert.deepEqual((await read()).events, []);
  console.log('PASS: leaving and revisiting the same chat invalidates the earlier save');

  await fresh();
  await page.getByLabel('Антиспам', { exact: true }).check();
  await save();
  delayRefresh = true;
  const refreshRequested = page.waitForRequest('**/api/chats/*/settings');
  await reply(409);
  await refreshRequested;
  await page.getByRole('button', { name: 'Другой чат' }).click();
  await page.getByLabel('Лимит', { exact: true }).fill('600');
  const whileRefreshing = await read();
  assert.ok(pendingRefresh);
  await pendingRefresh.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(serverSettings),
  });
  await page.waitForTimeout(100);
  assert.deepEqual(await read(), whileRefreshing);
  console.log('PASS: navigation during conflict refresh cannot open a stale conflict');

  await fresh();
  await page.getByLabel('Лимит', { exact: true }).fill('700');
  const dirty = (await read()).draft;
  serverSettings = {
    ...serverSettings,
    antiSpamEnabled: true,
    settingsRevision: '2026-10-03T00:03:00.000Z',
  };
  const refreshed = page.waitForResponse('**/api/chats/*/settings');
  await page.getByRole('button', { name: 'Обновить' }).click();
  await refreshed;
  await page.waitForTimeout(100);
  assert.deepEqual((await read()).draft, dirty);
  assert.deepEqual(errors, []);
  console.log('PASS: background refresh preserves unsaved changes');

  await fresh();
  await page.getByLabel('Стоп-слова', { exact: true }).check();
  await startStopSave(true);
  assert.equal(
    ordinaryWrites.length,
    0,
    'normalizing legacy settings must not create an ordinary write for a stop-only save',
  );
  await replyStop();
  await waitEvent('workspace saved');
  console.log(
    'PASS: stop-only workspace save normalizes its baseline and sends no unrelated ordinary write',
  );

  await fresh();
  await page.getByLabel('Антиспам', { exact: true }).check();
  await page.getByLabel('Стоп-слова', { exact: true }).check();
  const mixedStop = await startStopSave(true);
  assert.equal(ordinaryWrites.length, 1);
  for (const key of [
    'stopWordsPolicy',
    'stopWordsRevision',
    'messageLimitsBlockedWords',
    'messageLimitsBlockedDomains',
    'messageLimitsImageTextScanEnabled',
  ])
    assert.equal(Object.hasOwn(ordinaryWrites[0], key), false);
  assert.equal(JSON.parse(await page.getByTestId('server').innerText()).antiSpamEnabled, true);
  assert.equal((await read()).draft.stopWordsRevision, 7);
  await replyStop(500);
  await waitEvent('workspace error');
  assert.equal((await read()).dirty, true);
  assert.equal((await read()).draft.antiSpamEnabled, true);
  assert.equal((await read()).draft.stopWordsPolicy.enabled, true);
  const retriedStop = await startStopSave(true);
  assert.deepEqual(retriedStop, mixedStop);
  assert.equal(ordinaryWrites.length, 1, 'retry must not resend acknowledged ordinary settings');
  await replyStop();
  await waitEvent('workspace saved');
  assert.equal((await read()).dirty, false);
  console.log(
    'PASS: mixed hook save commits ordinary baseline before original stop CAS; partial failure retains remaining draft and retries it only',
  );

  await fresh();
  const originalWorkspaceFence = (await read()).draft.settingsRevision;
  await page.getByLabel('Антиспам', { exact: true }).check();
  await page.getByLabel('Стоп-слова', { exact: true }).check();
  holdOrdinary = true;
  const ordinaryStarted = page.waitForRequest(
    (request) => request.url().endsWith('/settings') && request.method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Сохранить всё', exact: true }).click();
  await ordinaryStarted;
  serverSettings = {
    ...serverSettings,
    messageCountLimitMessages: 8,
    settingsRevision: '2026-10-03T00:04:30.000Z',
  };
  const polled = page.waitForResponse(
    (response) => response.url().endsWith('/settings') && response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await polled;
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="server"]').textContent).settingsRevision ===
      '2026-10-03T00:04:30.000Z',
  );
  const stopAfterOrdinary = page.waitForRequest('**/api/chats/*/stop-words');
  await pendingOrdinary.route.fulfill({ json: pendingOrdinary.saved });
  const originalStopCAS = (await stopAfterOrdinary).postDataJSON();
  assert.equal(originalStopCAS.expectedRevision, 7);
  assert.equal(
    JSON.parse(await page.getByTestId('server').innerText()).messageCountLimitMessages,
    8,
  );
  assert.equal(
    JSON.parse(await page.getByTestId('server').innerText()).settingsRevision,
    '2026-10-03T00:04:30.000Z',
  );
  failRefresh = true;
  await replyStop();
  await waitEvent('workspace saved');
  assert.equal(
    JSON.parse(await page.getByTestId('server').innerText()).settingsRevision,
    '2026-10-03T00:04:30.000Z',
  );
  assert.equal(
    JSON.parse(await page.getByTestId('server').innerText()).messageCountLimitMessages,
    8,
  );
  assert.equal((await read()).draft.settingsRevision, originalWorkspaceFence);
  assert.equal((await read()).draft.antiSpamEnabled, true);
  assert.equal((await read()).draft.stopWordsRevision, 8);
  console.log(
    'PASS: delayed ordinary receipt cannot replace newer full cache; failed stop refresh retains cache and conservative draft fence',
  );

  await fresh();
  await page.getByLabel('Стоп-слова', { exact: true }).check();
  await startStopSave();
  await page.getByLabel('Стоп-слова', { exact: true }).uncheck();
  await page.getByLabel('Порог сообщений', { exact: true }).fill('9');
  await replyStop();
  await waitEvent('saved');
  assert.equal((await read()).draft.stopWordsPolicy.enabled, false);
  assert.equal((await read()).draft.messageCountLimitMessages, 9);
  assert.equal((await read()).dirty, true);
  console.log(
    'PASS: stop receipt and complete refresh preserve edits made while the hook save is pending',
  );

  for (const status of [200, 500, 409]) {
    for (const revisit of [false, true]) {
      await fresh();
      await page.getByLabel('Стоп-слова', { exact: true }).check();
      await startStopSave();
      await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
      if (revisit) await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
      await page.getByLabel('Лимит', { exact: true }).fill(revisit ? '650' : '900');
      const before = await read();
      await replyStop(status);
      await page.waitForTimeout(100);
      assert.deepEqual(await read(), before);
    }
  }
  console.log('PASS: late stop success, failure and conflict cannot mutate B or revisited A');

  await fresh();
  await page.getByLabel('Стоп-слова', { exact: true }).check();
  await startStopSave();
  delayRefresh = true;
  const stopRefresh = page.waitForRequest('**/api/chats/*/settings');
  await replyStop();
  await stopRefresh;
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
  await page.getByLabel('Порог сообщений', { exact: true }).fill('8');
  const afterRevisit = await read();
  await pendingRefresh.fulfill({ json: serverSettings });
  await page.waitForTimeout(100);
  assert.deepEqual(await read(), afterRevisit);
  console.log('PASS: delayed full stop refresh cannot rebase a revisited chat');

  for (const outcome of ['independent', 'overlap', 'unavailable']) {
    await fresh();
    await page.getByLabel('Стоп-слова', { exact: true }).check();
    await startStopSave();
    await page.getByLabel('Порог сообщений', { exact: true }).fill('9');
    const originalFence = (await read()).draft.settingsRevision;
    failRefresh = outcome === 'unavailable';
    await replyStop(200, {
      antiSpamEnabled: true,
      ...(outcome === 'overlap' ? { messageCountLimitMessages: 10 } : {}),
      settingsRevision: '2026-10-03T00:06:00.000Z',
    });
    await waitEvent('saved');
    const current = await read();
    assert.equal(current.draft.messageCountLimitMessages, 9);
    assert.equal(
      current.draft.settingsRevision,
      outcome === 'independent' ? '2026-10-03T00:06:00.000Z' : originalFence,
    );
    const sectionRequest = page.waitForRequest('**/api/chats/*/settings/section');
    await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const outgoing = await sectionRequest;
    assert.equal(outgoing.postDataJSON().expectedRevision, current.draft.settingsRevision);
    await reply();
    await waitEvent('saved');
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: next ordinary request uses refreshed fence only after complete nonoverlapping stop refresh',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}

await import('./settings-stop-words.browser.mjs');
