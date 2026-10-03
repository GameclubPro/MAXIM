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
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-subscription-'));
let browser;
const channel = {
  id: 'resolved-source',
  title: 'Источник',
  entityType: 'channel',
  link: 'https://max.ru/source',
  participantsCount: 10,
};
const endpoint = '**/api/chats/*/required-subscription/channels/resolve';

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
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      await context.route('**/required-subscription-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/app/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
        window.__vite_plugin_react_preamble_installed__=true;
        await import('/app/test/fixtures/settings-required-subscription-harness.tsx');
      </script></body></html>`,
        }),
      );
      const page = await context.newPage();
      const errors = [];
      const pending = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route(endpoint, (route) => {
        pending.push(route);
      });
      const fresh = async () => {
        pending.length = 0;
        await page.goto(`${baseUrl}required-subscription-test`);
        await page.getByLabel('Добавить по ссылке').waitFor();
        await page.evaluate((theme) => {
          document.documentElement.dataset.maxTheme = theme;
        }, colorScheme);
      };
      const readDraft = async () => JSON.parse(await page.getByTestId('draft').innerText());
      const submit = async () => {
        await page.getByLabel('Добавить по ссылке').fill('https://max.ru/source');
        const request = page.waitForRequest(endpoint);
        await page.getByRole('button', { name: 'Добавить', exact: true }).click();
        const sent = await request;
        assert.equal(
          new URL(sent.url()).pathname,
          '/api/chats/chat-a/required-subscription/channels/resolve',
        );
        assert.deepEqual(sent.postDataJSON(), { value: 'https://max.ru/source' });
        await page.getByRole('button', { name: 'Проверяем...', exact: true }).waitFor();
      };
      const settle = async (status = 200) => {
        assert.equal(pending.length, 1);
        await pending[0].fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(status === 200 ? { channel } : { message: 'Ошибка поиска' }),
        });
        await page.waitForFunction(() => document.body.dataset.settledRequests === '1');
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };

      await fresh();
      await submit();
      await page.getByRole('button', { name: 'Проверяем...', exact: true }).click({ force: true });
      await page.getByRole('button', { name: 'Изменить черновик', exact: true }).click();
      const edited = (await readDraft()).antiSpamEnabled;
      await settle();
      await page.waitForFunction(() =>
        JSON.parse(document.querySelector('[data-testid="draft"]').textContent).ids.includes(
          'resolved-source',
        ),
      );
      assert.equal((await readDraft()).antiSpamEnabled, edited);
      assert.equal(await page.getByLabel('Добавить по ссылке').inputValue(), '');
      assert.equal(pending.length, 1);

      await fresh();
      await submit();
      await page.getByRole('button', { name: 'Заполнить список', exact: true }).click();
      const fullDraft = await readDraft();
      await settle();
      await page.getByRole('alert').waitFor();
      assert.deepEqual(await readDraft(), fullDraft);
      assert.equal(
        await page.getByLabel('Добавить по ссылке').inputValue(),
        'https://max.ru/source',
      );
      assert.deepEqual(JSON.parse(await page.getByTestId('notifications').innerText()), []);

      for (const status of [200, 500]) {
        await fresh();
        await submit();
        await page.getByRole('button', { name: 'Другой чат', exact: true }).click();
        await page.getByLabel('Добавить по ссылке').fill('https://max.ru/new-chat-source');
        const newDraft = await readDraft();
        await settle(status);
        assert.deepEqual(await readDraft(), newDraft);
        assert.equal(
          await page.getByLabel('Добавить по ссылке').inputValue(),
          'https://max.ru/new-chat-source',
        );
        assert.equal(await page.getByRole('alert').count(), 0);
        assert.deepEqual(JSON.parse(await page.getByTestId('notifications').innerText()), []);
      }

      await fresh();
      await submit();
      await settle(500);
      await page.getByRole('alert').waitFor();
      assert.equal(
        await page.getByLabel('Добавить по ссылке').inputValue(),
        'https://max.ru/source',
      );
      assert.deepEqual((await readDraft()).ids, []);
      await page.getByRole('button', { name: 'Добавить локальный источник', exact: true }).click();
      assert.deepEqual((await readDraft()).ids, ['local-source']);
      await page.getByRole('button', { name: 'Удалить локальный источник', exact: true }).click();
      assert.equal((await readDraft()).enabled, false);
      assert.equal((await readDraft()).expires, '');
      assert.deepEqual(errors, []);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
      await page.goto(`${baseUrl}chat/preview-chat/settings?preview=1&focus=requiredSubscription`);
      const disclosure = page.getByRole('button', { name: 'Добавить источник', exact: true });
      await disclosure.waitFor();
      if ((await disclosure.getAttribute('aria-expanded')) !== 'true') await disclosure.click();
      await page.getByLabel('Добавить по ссылке').waitFor();
      await page.getByLabel('Найти чат или канал', { exact: true }).waitFor();
      await page.locator('.required-subscription__source-skeleton').waitFor({ state: 'hidden' });
      await applyNativeVisualMode(page, {
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.maxTheme),
        colorScheme,
      );
      await page.screenshot({
        path: path.join(screenshots, `${name}-settings.png`),
        fullPage: false,
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: request identity, late success/error, live draft, failure retention and duplicate-click protection`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
