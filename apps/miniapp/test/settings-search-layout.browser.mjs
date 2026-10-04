import assert from 'node:assert/strict';
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

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const profiles = [
  ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
  ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
  ['android-light', devices['Pixel 7'], 'light', 'android'],
  ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light', 'desktop'],
];
const routes = [
  ['chat', 'chat/preview-chat/settings', 'Антидубль', '.settings-drilldown__panel--duplicates'],
  [
    'channel',
    'channel/preview-channel/settings',
    'Действие под публикацией',
    '.settings-drilldown__panel--signature',
  ],
];

async function settledBox(locator) {
  return locator.evaluate(async (element) => {
    await document.fonts.ready;
    let previous;
    let stable = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise(requestAnimationFrame);
      const { x, y, width, height } = element.getBoundingClientRect();
      const current = { x, y, width, height };
      stable =
        previous &&
        Object.keys(current).every((key) => Math.abs(current[key] - previous[key]) < 0.1)
          ? stable + 1
          : 0;
      if (stable >= 5) return current;
      previous = current;
    }
    throw new Error('Settings geometry did not settle within 120 animation frames');
  });
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of profiles) {
    for (const [entity, routePath, title, panelSelector] of routes) {
      const context = await browser.newContext({ ...device, colorScheme });
      let releaseModule;
      const held = new Promise((resolve) => {
        releaseModule = resolve;
      });
      let requested = false;
      try {
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await context.route('**/src/components/ui/settings-overview-search.tsx*', async (route) => {
          requested = true;
          await held;
          await route.continue();
        });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}${routePath}?preview=1`, { waitUntil: 'domcontentloaded' });
        const entry = page.getByRole('button', { name: title, exact: true });
        await entry.waitFor({ state: 'visible' });
        await applyNativeVisualMode(page, {
          safeTop: platform === 'ios' ? 44 : 0,
          safeBottom: platform === 'ios' ? 34 : 0,
        });
        assert.equal(requested, true, 'The actual lazy search module must be held');
        const placeholder = page.locator('.settings-overview-search-wrap[aria-hidden="true"]');
        assert.equal(await placeholder.count(), 1);
        assert.equal(await page.getByRole('searchbox', { name: 'Найти настройку' }).count(), 0);
        assert.equal(await placeholder.evaluate((element) => element.inert), true);
        assert.equal(
          await placeholder.locator('input').evaluate((input) => {
            input.focus();
            return document.activeElement === input;
          }),
          false,
        );
        await page.keyboard.press('Tab');
        assert.equal(
          await placeholder.evaluate((element) => element.contains(document.activeElement)),
          false,
        );
        await page.evaluate(async () => {
          const { PREVIEW_REQUEST_HANDLERS } =
            await import('/app/src/lib/api/preview-transport.ts');
          const { PREVIEW_NOT_HANDLED } =
            await import('/app/src/lib/api/preview-transport-runtime.ts');
          window.__SEARCH_LAYOUT_WRITES__ = [];
          PREVIEW_REQUEST_HANDLERS.unshift(({ method }) => {
            if (method !== 'GET') window.__SEARCH_LAYOUT_WRITES__.push(method);
            return PREVIEW_NOT_HANDLED;
          });
        });
        await entry.scrollIntoViewIfNeeded();
        const before = await settledBox(entry);
        const placeholderBox = await placeholder.boundingBox();
        assert.ok(placeholderBox?.height > 0, 'Hidden fallback must occupy real space');
        if (platform === 'desktop') {
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
        }
        releaseModule();
        const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
        await search.waitFor({ state: 'visible' });
        const after = await settledBox(entry);
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.ok(
            Math.abs(before[key] - after[key]) <= 0.5,
            `${name}/${entity} ${key} shifted: ${before[key]} → ${after[key]}`,
          );
        }
        const readyBox = await page.locator('.settings-overview-search-wrap').boundingBox();
        assert.ok(
          Math.abs(readyBox.height - placeholderBox.height) <= 0.5,
          'Fallback and ready search heights must agree',
        );
        assert.equal(await placeholder.count(), 0);
        if (platform === 'desktop') await page.mouse.up();
        else await entry.tap();
        await page.locator(panelSelector).waitFor({ state: 'visible' });
        assert.equal(await page.locator('.settings-drilldown__panel:visible').count(), 1);
        assert.deepEqual(await page.evaluate(() => window.__SEARCH_LAYOUT_WRITES__), []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}/${entity}: delayed search keeps ${readyBox.height}px geometry, inert fallback, intended section and no writes`,
        );
      } finally {
        releaseModule();
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
