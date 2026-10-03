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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/publication-session-test*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-session-harness.tsx');</script></body></html>`,
    }),
  );
  const pending = [];
  await page.route('**/api/publications/**', (route) => pending.push(route));
  await page.route('**/api/publications/drafts', (route) => pending.push(route));
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const open = (name) => page.getByRole('button', { name, exact: true }).click();
  const next = async () => {
    for (let i = 0; i < 100; i++) {
      if (pending.length) return pending.shift();
      await page.waitForTimeout(20);
    }
    throw Error('Missing editor request');
  };
  const reply = async (route, data, status = 200) => {
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  };
  const waitState = async (expression) => page.waitForFunction(expression);
  await page.goto(`${base}publication-session-test`);
  await open('Исходный черновик');
  assert.equal((await read()).missing, 2);
  const details = (await read()).response;
  await open('Править публикацию');
  const initial = await next();
  await reply(initial, details);
  await waitState(
    () =>
      JSON.parse(document.querySelector('[data-testid="state"]').textContent).context?.kind ===
      'edit',
  );
  assert.equal((await read()).text, 'Текст');
  assert.equal((await read()).missing, 0);
  await page.getByLabel('Текст').fill('Мои правки');
  await open('Занятый редактор');
  assert.equal((await read()).confirm, false);
  assert.equal((await read()).context.kind, 'edit');
  await open('Обновить версию');
  const refresh = await next();
  await reply(refresh, {
    ...details,
    version: 5,
    content: { ...details.content, revision: 4, text: 'Обновлённый сервер' },
  });
  await waitState(
    () =>
      JSON.parse(document.querySelector('[data-testid="state"]').textContent).context
        ?.expectedRevision === 5,
  );
  assert.equal((await read()).text, 'Мои правки');
  await open('Назад');
  await waitState(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).confirm,
  );
  await open('Остаться');
  assert.equal((await read()).text, 'Мои правки');
  await open('Назад');
  await waitState(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).confirm,
  );
  await open('Закрыть без сохранения');
  assert.equal((await read()).context, null);
  assert.equal((await read()).text, 'Локальный черновик');
  assert.equal((await read()).missing, 2);
  await waitState(() => document.activeElement?.textContent === 'Править публикацию');
  assert.equal(new URL(page.url()).searchParams.has('compose'), false);
  console.log(
    'PASS: isolated edit keeps the create draft, rebases local edits, confirms dirty close and restores missing media and focus',
  );

  await open('Править публикацию');
  const failed = await next();
  await reply(failed, { message: 'Недоступно' }, 500);
  await waitState(
    () => !JSON.parse(document.querySelector('[data-testid="state"]').textContent).opening,
  );
  assert.equal((await read()).context, null);
  assert.equal((await read()).text, 'Локальный черновик');
  assert.equal((await read()).missing, 2);
  console.log('PASS: failed opening leaves the local draft and missing-image recovery untouched');

  await open('Без фото');
  await open('Создать');
  await page.getByLabel('Текст').fill('Черновик при ошибке облака');
  await open('Назад');
  const save = await next();
  assert.equal(save.request().method(), 'POST');
  assert.equal(save.request().postDataJSON().content.text, 'Черновик при ошибке облака');
  await reply(save, { message: 'Облако недоступно' }, 500);
  await waitState(
    () =>
      !JSON.parse(document.querySelector('[data-testid="state"]').textContent).closing &&
      JSON.parse(document.querySelector('[data-testid="state"]').textContent).context === null,
  );
  assert.equal((await read()).text, 'Черновик при ошибке облака');
  await page.reload();
  await page.getByTestId('state').waitFor();
  await waitState(
    () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).hydrated,
  );
  assert.equal((await read()).text, 'Черновик при ошибке облака');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: failed cloud flush closes safely with local persistence and restores the draft after reload',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
