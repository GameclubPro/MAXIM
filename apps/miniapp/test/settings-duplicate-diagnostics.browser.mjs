import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-duplicate-diagnostics-'));
const timestamp = '2026-10-05T12:00:00.000Z';
function attempt(id, state = 'REQUESTED') {
  return {
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    registeredAt: timestamp,
    outcome: 'DELETED',
    reason: null,
    nextAttemptAt: null,
    target: { messageId: id, publishedAt: timestamp },
    original: { messageId: `original-${id}`, publishedAt: timestamp, repeatAllowedAt: timestamp },
    comparison: { mode: 'TEXT', kind: 'exact', windowSeconds: 43200, firstDeletedMessageNumber: 2 },
    sanction: { action: 'WARN', state },
  };
}
function diagnostics(
  prefix,
  enabled,
  rows = [
    {
      ...attempt('shared-first'),
      target: { messageId: `${prefix}-first`, publishedAt: timestamp },
    },
  ],
  cursor = 'page-2',
) {
  return {
    generatedAt: timestamp,
    enabled,
    mode: 'FULL',
    capability: { state: 'CONFIRMED', checkedAt: timestamp },
    history: {
      available: true,
      since: timestamp,
      sampledIntents: rows.length,
      limited: true,
      coverage: 'PROJECTED_ONLY',
      attempts: rows,
      nextCursor: cursor,
    },
  };
}
async function openHistory(panel) {
  await panel.getByText('Проверка и история', { exact: true }).waitFor();
  if (!(await panel.locator('details').evaluate((node) => node.open)))
    await panel.getByText('Проверка и история', { exact: true }).click();
}
async function waitHeld(queue) {
  const deadline = Date.now() + 10000;
  while (!queue.length && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(queue.length, 'Expected the delayed test request');
}
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
    ['android-light', devices['Pixel 7'], 'light', 'android'],
    ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      // All caches deliberately share a timestamp: identity must guard responses independently.
      await context.addInitScript((value) => {
        Date.now = () => value;
      }, Date.parse(timestamp));
      await context.route('**/diagnostics-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/app/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/app/test/fixtures/settings-duplicate-diagnostics-harness.tsx");</script></body></html>',
        }),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      const heldPages = [];
      const heldLinks = [];
      const stored = new Map();
      let holdPage = false;
      let holdLink = false;
      let invalidLink = false;
      let pageNumber = 0;
      let reads = 0;
      page.on('pageerror', (error) => {
        errors.push(error.message);
        console.error(`${name}: ${error.message}`);
      });
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (!url.pathname.startsWith('/api/')) return route.continue();
        const chat = url.pathname.includes('/chat-b/') ? 'b' : 'a';
        const user = request.headers()['x-test-user'] === 'user-2' ? 'u2' : 'u1';
        const prefix = `${chat}-${user}`;
        if (url.pathname.endsWith('/settings-screen'))
          return route.fulfill({
            json: {
              settings: {
                antiDuplicateEnabled: stored.get(prefix) ?? true,
                settingsRevision: '2026-10-05T00:00:00.000Z',
              },
            },
          });
        if (url.pathname.endsWith('/settings/section')) {
          stored.set(prefix, request.postDataJSON().changes.antiDuplicateEnabled);
          return route.fulfill({
            json: { antiDuplicateEnabled: false, settingsRevision: '2026-10-05T12:00:00.000Z' },
          });
        }
        if (url.pathname.includes('/message-link/')) {
          if (holdLink) {
            heldLinks.push(route);
            return;
          }
          return route.fulfill({
            json: invalidLink
              ? { state: 'AVAILABLE', url: 'https://max.ru.evil.test/message' }
              : { state: 'AVAILABLE', url: 'https://max.ru/c/test/123' },
          });
        }
        if (url.searchParams.has('cursor')) {
          if (holdPage) {
            heldPages.push({ route, prefix });
            return;
          }
          pageNumber += 1;
          return route.fulfill({
            json: diagnostics(
              prefix,
              stored.get(prefix) ?? true,
              Array.from({ length: 5 }, (_, index) =>
                attempt(
                  `${prefix}-page-${pageNumber}-${index}`,
                  index % 2 ? 'REQUESTED' : 'CONFIRMED',
                ),
              ),
              `page-${pageNumber + 2}`,
            ),
          });
        }
        reads += 1;
        return route.fulfill({ json: diagnostics(prefix, stored.get(prefix) ?? true) });
      });
      await page.goto(`${base}diagnostics-test`);
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      const panel = page.locator('.duplicate-diagnostics');
      await openHistory(panel);
      await panel.getByText('Номер повтора: a-u1-first', { exact: true }).waitFor();
      await panel.getByText('Одинаковый текст', { exact: true }).waitFor();
      await panel
        .getByText('Предупреждение: запланировано, выполнение не подтверждено', { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
        false,
      );
      await page.screenshot({
        path: path.join(screenshots, `${name}-history.png`),
        fullPage: true,
      });
      const beforeSave = reads;
      await page.getByRole('button', { name: 'Сохранить выключение', exact: true }).click();
      await panel
        .locator('dd')
        .filter({ hasText: /^Выключен$/u })
        .waitFor();
      assert.ok(reads > beforeSave, 'Successful settings save refetches the mounted diagnostics');

      await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
      await panel.getByText('Номер повтора: a-u1-page-1-0', { exact: true }).waitFor();
      await panel
        .getByText('Предупреждение: выполнение подтверждено', { exact: true })
        .first()
        .waitFor();
      holdPage = true;
      await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('.duplicate-diagnostics button:disabled') !== null,
      );
      await waitHeld(heldPages);
      await page.getByRole('button', { name: 'Чат B', exact: true }).click();
      await panel
        .getByText('Номер повтора: b-u1-first', { exact: true })
        .waitFor({ state: 'attached' });
      await openHistory(panel);
      await panel.getByText('Номер повтора: b-u1-first', { exact: true }).waitFor();
      assert.equal(await panel.getByText(/Номер повтора: a-u1/u).count(), 0);
      const oldChatPage = heldPages.shift();
      await oldChatPage.route.fulfill({
        json: diagnostics(oldChatPage.prefix, true, [attempt('stale-chat-page')], null),
      });
      await page.waitForTimeout(50);
      assert.equal(
        await panel.getByText('Номер повтора: stale-chat-page', { exact: true }).count(),
        0,
      );

      await panel.getByRole('button', { name: 'Показать ещё', exact: true }).click();
      await waitHeld(heldPages);
      await page.getByRole('button', { name: 'Пользователь 2', exact: true }).click();
      await panel
        .getByText('Номер повтора: b-u2-first', { exact: true })
        .waitFor({ state: 'attached' });
      await openHistory(panel);
      await panel.getByText('Номер повтора: b-u2-first', { exact: true }).waitFor();
      const oldUserPage = heldPages.shift();
      await oldUserPage.route.fulfill({
        json: diagnostics(oldUserPage.prefix, true, [attempt('stale-user-page')], null),
      });
      await page.waitForTimeout(50);
      assert.equal(
        await panel.getByText('Номер повтора: stale-user-page', { exact: true }).count(),
        0,
      );
      holdPage = false;

      for (const move of ['Чат A', 'Пользователь 1', 'Уйти с экрана']) {
        holdLink = true;
        await panel.getByRole('button', { name: 'Открыть повтор', exact: true }).first().click();
        await waitHeld(heldLinks);
        await page.getByRole('button', { name: move, exact: true }).click();
        await heldLinks
          .shift()
          .fulfill({ json: { state: 'AVAILABLE', url: 'https://max.ru/c/old-chat/123' } });
        await page.waitForTimeout(50);
        assert.equal(
          await page.evaluate(
            () =>
              window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) =>
                ['openLink', 'openMaxLink'].includes(event.type),
              ).length,
          ),
          0,
        );
        if (move === 'Уйти с экрана')
          await page.getByRole('button', { name: 'Вернуться', exact: true }).click();
        await openHistory(panel);
        await panel.locator('li').first().waitFor();
      }
      holdLink = false;
      invalidLink = true;
      await panel.getByRole('button', { name: 'Открыть повтор', exact: true }).first().click();
      await panel.getByText('Ссылка недоступна', { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) =>
              ['openLink', 'openMaxLink'].includes(event.type),
            ).length,
        ),
        0,
      );
      invalidLink = false;
      await panel.getByRole('button', { name: 'Открыть оригинал', exact: true }).first().click();
      await page.waitForFunction(() =>
        window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) => event.type === 'openMaxLink'),
      );
      for (let index = 0; index < 10; index += 1) {
        const more = panel.getByRole('button', { name: 'Показать ещё', exact: true });
        if (!(await more.count())) break;
        const previous = await panel.locator('li').count();
        await more.click();
        await page.waitForFunction(
          (count) => document.querySelectorAll('.duplicate-diagnostics li').length > count,
          previous,
        );
      }
      assert.equal(await panel.locator('li').count(), 50);
      assert.equal(
        await panel.getByRole('button', { name: 'Показать ещё', exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: save refresh, same-timestamp chat/account races, delayed links, safe links, bounded pages`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
console.log(`Screenshots: ${screenshots}`);
