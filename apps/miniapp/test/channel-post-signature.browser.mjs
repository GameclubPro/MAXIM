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

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-post-signature-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme] of [
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light'],
    ['iphone-light', devices['iPhone SE'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(baseUrl).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${baseUrl}channel/preview-channel/settings?preview=1`);
      await applyNativeVisualMode(page, {
        safeTop: 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      const entry = page.getByRole('button', { name: 'Действие под публикацией', exact: true });
      await entry.click();
      const panel = page.locator('.settings-drilldown__panel--signature');
      await panel.waitFor({ state: 'visible' });
      await page.evaluate(async () => {
        const { PREVIEW_REQUEST_HANDLERS } = await import('/app/src/lib/api/preview-transport.ts');
        const { PREVIEW_NOT_HANDLED } =
          await import('/app/src/lib/api/preview-transport-runtime.ts');
        window.signatureTest = { requests: [], delay: false, release: null, saved: null };
        PREVIEW_REQUEST_HANDLERS.unshift(async ({ url, method, init, state }) => {
          if (!url.pathname.endsWith('/post-signature') || method !== 'PATCH')
            return PREVIEW_NOT_HANDLED;
          const payload = JSON.parse(init.body);
          const test = window.signatureTest;
          test.requests.push(payload);
          if (test.requests.length > 20) throw new Error('Signature save loop');
          if (test.delay) {
            test.delay = false;
            await new Promise((resolve) => {
              test.release = resolve;
            });
          }
          const saved = { ...state.channelPostSignature, ...payload };
          if (saved.text === 'server-normalize') saved.text = 'Server normalized';
          state.channelPostSignature = saved;
          test.saved = saved;
          return structuredClone(saved);
        });
      });
      const text = panel.locator('#channel-post-signature-text');
      const url = panel.locator('#channel-post-signature-url');
      const saved = panel.getByText('Сохранено', { exact: true });
      await panel.getByRole('checkbox', { name: 'Действие под публикацией' }).check();
      await text.fill('Read channel');
      await text.blur();
      await saved.waitFor();
      await panel.getByRole('radio', { name: 'Кнопка', exact: true }).click();
      await saved.waitFor();
      assert.equal(await page.evaluate(() => window.signatureTest.saved.presentation), 'button');

      const beforeInvalid = await page.evaluate(() => window.signatureTest.requests.length);
      await text.fill('');
      await text.blur();
      assert.equal(await text.getAttribute('aria-invalid'), 'true');
      assert.equal(await page.evaluate(() => window.signatureTest.requests.length), beforeInvalid);
      await text.fill('Read channel');
      await text.blur();
      await panel.getByRole('radio', { name: 'Ссылка в тексте', exact: true }).click();
      await text.fill('x'.repeat(33));
      await text.blur();
      await saved.waitFor();
      const beforeMode = await page.evaluate(() => window.signatureTest.requests.length);
      await panel.getByRole('radio', { name: 'Кнопка', exact: true }).click();
      assert.equal(await text.inputValue(), 'x'.repeat(33));
      assert.equal(await text.getAttribute('aria-invalid'), 'true');
      assert.equal(await page.evaluate(() => window.signatureTest.requests.length), beforeMode);
      await text.fill('Read channel');
      await text.blur();
      await saved.waitFor();

      await url.fill('javascript:alert(1)');
      await url.blur();
      assert.equal(await url.getAttribute('aria-invalid'), 'true');
      await url.fill('https://example.com/read');
      await url.blur();
      await saved.waitFor();

      await page.evaluate(() => {
        window.signatureTest.delay = true;
      });
      await text.fill('First edit');
      await text.blur();
      await page.waitForFunction(() => window.signatureTest.release !== null);
      await text.fill('Latest edit');
      await text.blur();
      await page.evaluate(() => window.signatureTest.release());
      await saved.waitFor();
      assert.equal(await text.inputValue(), 'Latest edit');
      assert.equal(await page.evaluate(() => window.signatureTest.saved.text), 'Latest edit');

      const beforeNormalization = await page.evaluate(() => window.signatureTest.requests.length);
      await text.fill('server-normalize');
      await text.blur();
      await saved.waitFor();
      assert.equal(await text.inputValue(), 'Server normalized');
      assert.equal(
        await page.evaluate(() => window.signatureTest.requests.length),
        beforeNormalization + 1,
      );
      await text.focus();
      await page.screenshot({ path: path.join(screenshots, `${name}.png`) });
      const layout = await panel.evaluate((element) => ({
        fits: element.scrollWidth <= element.clientWidth,
        screenFits: document.documentElement.scrollWidth <= innerWidth,
      }));
      assert.deepEqual(layout, { fits: true, screenFits: true });
      assert.deepEqual(errors, []);
      console.log(`${name}: signature mode, validation, save race and normalization passed`);
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
