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
  await page.route('**/api/chats/*/settings', (route) => {
    if (delayRefresh) {
      pendingRefresh = route;
      return;
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(serverSettings) });
  });
  await page.route('**/api/chats/*/settings/section', (route) => {
    pending.push(route);
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const fresh = async () => {
    pending = [];
    pendingRefresh = undefined;
    delayRefresh = false;
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
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
