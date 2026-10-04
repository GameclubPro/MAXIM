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
  await page.route('**/settings-rules-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
    window.__vite_plugin_react_preamble_installed__=true;
    await import('/app/test/fixtures/settings-rules-harness.tsx');
  </script></body></html>`,
    }),
  );
  let requests = [];
  let initial;
  await page.route('**/api/chats/*/rules**', (route) => {
    requests.push(route);
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const fresh = async () => {
    requests = [];
    await page.goto(`${base}settings-rules-test`);
    await page.waitForFunction(() =>
      Boolean(
        JSON.parse(document.querySelector('[data-testid="state"]')?.textContent ?? '{}').draft,
      ),
    );
    initial = (await read()).draft;
  };
  const waitCount = async (count) => {
    for (let i = 0; i < 100 && requests.length < count; i++) await page.waitForTimeout(20);
    assert.equal(requests.length, count);
  };
  const reply = async (index, status = 200, body) => {
    const route = requests[index];
    const done = page.waitForResponse(
      (response) =>
        response.url() === route.request().url() &&
        response.request().method() === route.request().method(),
    );
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        body ??
          (status === 200
            ? { ...initial, ...route.request().postDataJSON() }
            : { message: 'Ошибка сохранения' }),
      ),
    });
    await done;
    await page.waitForTimeout(50);
  };
  await fresh();
  const editor = page.getByLabel('Правила', { exact: true });
  await editor.fill('Первая редакция');
  await waitCount(1);
  assert.equal(requests[0].request().method(), 'PUT');
  assert.equal(new URL(requests[0].request().url()).pathname, '/api/chats/chat-a/rules');
  assert.equal(Object.hasOwn(requests[0].request().postDataJSON(), 'publishedMessageId'), false);
  assert.equal(await editor.isEnabled(), true);
  await editor.fill('Новая редакция во время сохранения');
  await reply(0);
  assert.equal((await read()).draft.text, 'Новая редакция во время сохранения');
  assert.equal((await read()).dirty, true);
  console.log('PASS: autosave payload excludes publication metadata and preserves newer edits');

  await fresh();
  await editor.fill('Не терять после ошибки');
  await waitCount(1);
  await reply(0, 500);
  await page.waitForTimeout(1000);
  assert.equal(requests.length, 1);
  assert.equal((await read()).draft.text, 'Не терять после ошибки');
  assert.equal((await read()).dirty, true);
  console.log('PASS: failed autosave retains draft and pauses unchanged retries');

  await fresh();
  await editor.fill('Публикация после сохранения');
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(1);
  await page.getByRole('button', { name: 'Другой чат' }).click();
  await editor.fill('Черновик другого чата');
  await reply(0);
  assert.equal((await read()).draft.text, 'Черновик другого чата');
  assert.equal(requests.filter((r) => r.request().method() === 'POST').length, 0);
  assert.deepEqual((await read()).events, []);
  console.log('PASS: navigation during save prevents subsequent publication');

  for (const status of [200, 500]) {
    await fresh();
    await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
    await waitCount(1);
    assert.deepEqual(requests[0].request().postDataJSON(), { mode: 'new_message' });
    await page.getByRole('button', { name: 'Другой чат' }).click();
    const before = await read();
    await reply(0, status, {
      chatId: 'chat-a',
      messageId: 'new-post',
      url: null,
      publishedAt: '2026-10-03T01:00:00.000Z',
      operation: 'created',
    });
    assert.deepEqual(await read(), before);
  }
  console.log('PASS: late publication success/error cannot affect another chat');

  await fresh();
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await waitCount(1);
  await page.getByRole('button', { name: 'Опубликовать', exact: true }).click({ force: true });
  await reply(0, 200, {
    chatId: 'chat-a',
    messageId: 'new-post',
    url: null,
    publishedAt: '2026-10-03T01:00:00.000Z',
    operation: 'created',
  });
  assert.equal(requests.length, 1);
  assert.equal((await read()).draft.publishedMessageId, 'new-post');
  assert.equal((await read()).draft.publishedUrl, null);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: duplicate-click protection and missing new link preserve publication identity',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
