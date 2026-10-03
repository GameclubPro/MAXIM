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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/publication-list-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
  import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
  await import('/app/test/fixtures/publication-list-harness.tsx');</script></body></html>`,
    }),
  );
  const requests = [];
  const calendar = [];
  await page.route('**/api/publications?*', (route) => {
    requests.push(route);
  });
  await page.route('**/api/publications/calendar-availability', (route) => {
    calendar.push(route);
    const body = route.request().postDataJSON();
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ from: body.from, to: body.to, slots: [] }),
    });
  });
  const read = async () => JSON.parse(await page.getByTestId('state').innerText());
  const waitRequest = async (predicate) => {
    for (let i = 0; i < 100; i++) {
      const r = requests.find((route) => predicate(new URL(route.request().url()).searchParams));
      if (r) return r;
      await page.waitForTimeout(20);
    }
    throw Error('Expected list request missing');
  };
  const reply = async (route, marker) => {
    const response = page.waitForResponse(route.request().url());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ items: [], nextCursor: marker }),
    });
    await response;
    await page.waitForTimeout(50);
  };
  await page.goto(`${base}publication-list-test`);
  const first = await waitRequest((p) => p.get('view') === 'current');
  assert.equal(new URL(first.request().url()).searchParams.get('limit'), '30');
  await reply(first, 'initial-next');
  await page.getByRole('button', { name: 'Ещё', exact: true }).click();
  const next = await waitRequest((p) => p.get('cursor') === 'initial-next');
  await reply(next, null);
  assert.equal((await read()).pages, 2);
  assert.equal(requests.length, 2);
  console.log('PASS: pagination uses the server cursor and waits for explicit load-more');

  await page.getByLabel('Поиск').fill('alpha');
  const old = await waitRequest((p) => p.get('query') === 'alpha');
  await page.getByLabel('Поиск').fill('beta');
  await page.getByRole('button', { name: 'Каналы', exact: true }).click();
  const current = await waitRequest(
    (p) => p.get('query') === 'beta' && p.get('entityType') === 'channel',
  );
  assert.equal(new URL(current.request().url()).searchParams.has('cursor'), false);
  await reply(current, 'beta-next');
  await reply(old, 'alpha-next');
  assert.equal((await read()).marker, 'beta-next');
  assert.equal((await read()).pages, 1);
  assert.equal(new URL(page.url()).searchParams.get('query'), 'beta');
  assert.equal(new URL(page.url()).searchParams.get('entity'), 'channel');
  console.log('PASS: new filters reset cursor scope and reject late old-query results');

  await page.getByRole('button', { name: 'Редактор', exact: true }).click();
  for (let i = 0; i < 100 && calendar.length === 0; i++) await page.waitForTimeout(20);
  assert.equal(calendar.length, 1);
  const body = calendar[0].request().postDataJSON();
  assert.deepEqual(body.audience, {
    selection: 'SELECTED',
    mode: 'SNAPSHOT',
    targets: [{ chatId: 'target-a', entityType: 'channel' }],
  });
  assert.equal(body.excludePublicationId, 'publication-a');
  assert.ok(Date.parse(body.to) > Date.parse(body.from));
  const before = requests.length;
  await page.getByLabel('Поиск').fill('editor-query');
  await page.waitForTimeout(400);
  assert.equal(requests.length, before);
  await page.getByRole('button', { name: 'Редактор', exact: true }).click();
  const after = await waitRequest((p) => p.get('query') === 'editor-query');
  await reply(after, null);
  await page.getByRole('button', { name: 'История', exact: true }).click();
  const history = await waitRequest(
    (p) => p.get('view') === 'history' && p.get('query') === 'editor-query',
  );
  assert.equal(new URL(history.request().url()).searchParams.get('entityType'), 'channel');
  await reply(history, null);
  assert.equal((await read()).view, 'history');
  assert.equal(calendar.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: editor suspends the feed, calendar retains target/exclusion scope and filters survive return',
  );
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
