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

const acknowledgementKey = 'maxim:incident:max-2026-10-16:acknowledged:v1';
const noticeSelector = 'dialog.max-incident-notice';
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const output = await mkdtemp(path.join(tmpdir(), 'maxim-incident-notice-'));
const mobileDevices = [
  { name: 'iphone-se', device: devices['iPhone SE'], platform: 'ios', safeTop: 20, safeBottom: 0 },
  { name: 'android', device: devices['Pixel 7'], platform: 'android', safeTop: 24, safeBottom: 24 },
];
let server;
let browser;

async function createFixture({
  device = mobileDevices[1],
  colorScheme = 'light',
  storage,
  withBridge = true,
} = {}) {
  const context = await browser.newContext({
    ...device.device,
    colorScheme,
    reducedMotion: 'reduce',
    locale: 'ru-RU',
  });
  context.setDefaultTimeout(12_000);
  context.setDefaultNavigationTimeout(25_000);
  const fixture = { context, device, page: null, errors: [], native: new Map(), pendingReads: [] };
  context.on('page', (page) => page.on('pageerror', (error) => fixture.errors.push(error.message)));
  // FLAG: Exercise the real App and router with local preview data; never reach a live API.
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  );
  if (withBridge) {
    await installMaxBridgeShimInitScript(context, device, {
      colorScheme,
      acknowledgeIncidentNotice: false,
    });
  }
  await installNativeVisualModeInitScript(context);
  if (storage?.acknowledged) fixture.native.set(acknowledgementKey, '1');
  if (storage) {
    await context.exposeFunction('__incidentReadNative', async (key) => {
      if (storage.mode === 'hung') return new Promise(() => {});
      if (storage.mode === 'controlled') {
        await new Promise((resolve) => fixture.pendingReads.push(resolve));
      }
      if (storage.delayMs) await new Promise((resolve) => setTimeout(resolve, storage.delayMs));
      return { key, value: fixture.native.get(key) ?? null };
    });
    await context.exposeFunction('__incidentWriteNative', (key, value) => {
      fixture.native.set(key, value);
      return { key, value };
    });
  }
  await context.addInitScript(
    ({ key, customStorage }) => {
      window.__incidentObservedOpen = false;
      window.__incidentNativeReads = 0;
      window.__incidentNativeWrites = 0;
      new MutationObserver(() => {
        if (document.querySelector('dialog.max-incident-notice[open]')) {
          window.__incidentObservedOpen = true;
        }
      }).observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['open'],
      });
      if (!customStorage) return;

      // Init-script order is unspecified: decorate an existing bridge and future assignments.
      const decorated = new WeakSet();
      const install = (bridge) => {
        if (!bridge || decorated.has(bridge)) return bridge;
        decorated.add(bridge);
        const original = bridge.DeviceStorage;
        bridge.DeviceStorage = {
          getItem(itemKey) {
            if (itemKey !== key) return original.getItem(itemKey);
            window.__incidentNativeReads += 1;
            return window.__incidentReadNative(itemKey);
          },
          async setItem(itemKey, value) {
            if (itemKey !== key) return original.setItem(itemKey, value);
            const result = await window.__incidentWriteNative(itemKey, value);
            window.__incidentNativeWrites += 1;
            return result;
          },
          removeItem: (itemKey) => original.removeItem(itemKey),
        };
        return bridge;
      };
      let bridge = install(window.WebApp);
      Object.defineProperty(window, 'WebApp', {
        configurable: true,
        get: () => bridge,
        set: (value) => {
          bridge = install(value);
        },
      });
      install(window.MAX?.WebApp);
      if (customStorage.nativeOnly) {
        const read = Storage.prototype.getItem;
        const write = Storage.prototype.setItem;
        Storage.prototype.getItem = function (itemKey) {
          if (itemKey === key) throw new Error('Incident local mirror is unavailable');
          return read.call(this, itemKey);
        };
        Storage.prototype.setItem = function (itemKey, value) {
          if (itemKey === key) throw new Error('Incident local mirror is unavailable');
          return write.call(this, itemKey, value);
        };
      }
    },
    { key: acknowledgementKey, customStorage: storage ?? null },
  );
  return fixture;
}

async function visit(fixture, route, readySelector = '.app-shell') {
  const page = await fixture.context.newPage();
  fixture.page = page;
  await page.goto(new URL(route, base).href, { waitUntil: 'domcontentloaded' });
  await page.locator(readySelector).first().waitFor();
  await applyNativeVisualMode(page, fixture.device);
  return page;
}

async function assertNoticeNeverOpened(page, waitMs = 350) {
  await page.waitForTimeout(waitMs);
  assert.equal(await page.locator(noticeSelector).count(), 0, 'Notice must remain absent');
  assert.equal(await page.evaluate(() => window.__incidentObservedOpen), false, 'Notice flashed');
}

async function assertNoticeLayout(page) {
  await page.locator(`${noticeSelector}[open]`).waitFor();
  await page.waitForFunction(() => {
    const dialog = document.querySelector('dialog.max-incident-notice');
    return dialog?.contains(document.activeElement);
  });
  const metrics = await page.locator(noticeSelector).evaluate((dialog) => {
    const button = dialog.querySelector('button');
    const rect = dialog.getBoundingClientRect();
    const action = button.getBoundingClientRect();
    return {
      modal: dialog.matches(':modal'),
      inBounds:
        rect.x >= -1 &&
        rect.y >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.bottom <= innerHeight + 1,
      reachable:
        action.height >= 44 &&
        button.contains(
          document.elementFromPoint(action.x + action.width / 2, action.y + action.height / 2),
        ),
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert.ok(metrics.modal && metrics.inBounds && metrics.reachable, JSON.stringify(metrics));
  assert.ok(metrics.overflow <= 1, JSON.stringify(metrics));
  const scroll = await page.locator('.max-incident-notice__scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const result = { needed: element.scrollHeight > element.clientHeight, top: element.scrollTop };
    element.scrollTop = 0;
    return result;
  });
  assert.ok(!scroll.needed || scroll.top > 0, 'Notice text must remain scrollable');
}

async function runCase(name, options, check) {
  const fixture = await createFixture(options);
  try {
    await check(fixture);
    assert.deepEqual(fixture.errors, []);
    console.log(`PASS ${name}`);
  } catch (error) {
    if (fixture.page && !fixture.page.isClosed()) {
      await fixture.page
        .screenshot({ path: path.join(output, `${name}-failed.png`) })
        .catch(() => {});
    }
    throw error;
  } finally {
    await fixture.context.close();
  }
}

try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch();
  for (const [profile, device, colorScheme] of [
    ['moderation', mobileDevices[0], 'light'],
    ['moderation', mobileDevices[1], 'dark'],
    ['publisher', mobileDevices[0], 'dark'],
    ['publisher', mobileDevices[1], 'light'],
  ]) {
    const name = `${profile}-${device.name}-${colorScheme}`;
    await runCase(name, { device, colorScheme }, async (fixture) => {
      const page = await visit(fixture, `?preview=1&profile=${profile}`);
      await assertNoticeLayout(page);
      await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
      await page.getByRole('button', { name: 'Ознакомлен', exact: true }).click();
      await page.locator(noticeSelector).waitFor({ state: 'detached' });
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), acknowledgementKey),
        '1',
      );
      if (profile === 'moderation' && colorScheme === 'light') {
        await page.reload();
        await page.locator('.app-shell').waitFor();
        await assertNoticeNeverOpened(page);
        const secondPage = await visit(fixture, '?preview=1&profile=publisher');
        await assertNoticeNeverOpened(secondPage);
      }
    });
  }

  await runCase(
    'keyboard-focus-and-escape',
    {
      device: {
        device: { viewport: { width: 1280, height: 900 } },
        platform: 'web',
        safeTop: 0,
        safeBottom: 0,
      },
      storage: { mode: 'controlled' },
    },
    async (fixture) => {
      const page = await visit(fixture, '?preview=1&profile=moderation');
      await page.waitForFunction(() => window.__incidentNativeReads > 0);
      const previousFocus = page.locator('.bottom-nav a').first();
      await previousFocus.focus();
      await page.evaluate(() => {
        window.__incidentBackgroundEscapes = 0;
        // Existing sheets listen on window; the visible notice must consume Escape first.
        window.addEventListener('keydown', (event) => {
          if (event.key !== 'Escape') return;
          window.__incidentBackgroundEscapes += 1;
          event.preventDefault();
          event.stopImmediatePropagation();
        });
      });
      assert.ok(fixture.pendingReads.length > 0, 'Controlled native read was not entered');
      fixture.pendingReads.splice(0).forEach((resolve) => resolve());
      await assertNoticeLayout(page);
      await page.keyboard.press('Tab');
      assert.equal(
        await page
          .getByRole('button', { name: 'Ознакомлен', exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press('Shift+Tab');
      assert.equal(
        await page.locator(noticeSelector).evaluate((el) => el.contains(document.activeElement)),
        true,
      );
      await page.keyboard.press('Escape');
      await page.locator(noticeSelector).waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__incidentBackgroundEscapes), 0);
      assert.equal(await previousFocus.evaluate((el) => el === document.activeElement), true);
      assert.equal(
        await page.evaluate((key) => localStorage.getItem(key), acknowledgementKey),
        null,
      );
    },
  );

  await runCase('native-back-and-shell-remount', {}, async (fixture) => {
    const page = await visit(fixture, '?preview=1&profile=moderation');
    await assertNoticeLayout(page);
    await page.waitForFunction(() => window.WebApp.BackButton.isVisible);
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await page.locator(noticeSelector).waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(() =>
        window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) => event.type === 'close'),
      ),
      false,
    );
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), acknowledgementKey), null);
    await page.locator('.chat-card[data-entity-id] .chat-card__primary-link').first().click();
    await page.waitForURL(/\/chat\/[^/]+\/settings/u);
    await page.locator('.settings-sections--chat-home').waitFor();
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator(noticeSelector).count(),
      0,
      'Session dismissal must survive a new Shell',
    );
  });

  for (const storage of [
    { name: 'native-ack-delayed', acknowledged: true, delayMs: 800, nativeOnly: true },
    { name: 'native-read-hung', mode: 'hung', nativeOnly: true },
  ]) {
    await runCase(storage.name, { storage }, async (fixture) => {
      const page = await visit(fixture, '?preview=1&profile=moderation');
      await page.waitForFunction(() => window.__incidentNativeReads > 0);
      await page.locator('.chat-card[data-entity-id]').first().waitFor();
      await assertNoticeNeverOpened(page, 1_800);
      await page.getByRole('navigation').getByRole('link', { name: 'Каналы', exact: true }).click();
      await page.locator('.chats-home--channel').waitFor();
    });
  }

  await runCase(
    'native-only-confirmation-survives-reload',
    { storage: { nativeOnly: true } },
    async (fixture) => {
      const page = await visit(fixture, '?preview=1&profile=publisher');
      await page.getByRole('button', { name: 'Ознакомлен', exact: true }).click();
      await page.waitForFunction(() => window.__incidentNativeWrites > 0);
      assert.equal(fixture.native.get(acknowledgementKey), '1');
      await page.reload();
      await page.locator('.app-shell').waitFor();
      await page.waitForFunction(() => window.__incidentNativeReads > 0);
      await assertNoticeNeverOpened(page);
    },
  );

  const excludedRoutes = [
    ['legal-agreement', 'legal/agreement', '.legal-page'],
    ['giveaway', 'giveaways/preview-giveaway?preview=1&profile=moderation', '.giveaway-page'],
    [
      'comments-publisher',
      'channel/preview-channel/dialog/comments?preview=1&profile=publisher&token=preview-comments-token-0001',
      '.channel-dialog-screen',
    ],
    [
      'suggestions-moderation',
      'channel/preview-channel/dialog/suggest?preview=1&profile=moderation&token=preview-suggest-token-0001',
      '.channel-dialog-screen--suggest',
    ],
  ];
  for (const [name, route, readySelector] of excludedRoutes) {
    await runCase(
      `excluded-${name}`,
      { withBridge: name !== 'legal-agreement' },
      async (fixture) => {
        const page = await visit(fixture, route, readySelector);
        await assertNoticeNeverOpened(page, 600);
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), acknowledgementKey),
          null,
        );
        assert.equal(
          await page.evaluate(
            async (key) => (await window.WebApp?.DeviceStorage?.getItem(key))?.value ?? null,
            acknowledgementKey,
          ),
          null,
        );
      },
    );
  }

  await runCase('optional-notice-chunk-unavailable', {}, async (fixture) => {
    let blockedNoticeLoads = 0;
    await fixture.context.route('**/src/components/max-incident-notice.tsx*', (route) => {
      blockedNoticeLoads += 1;
      return route.abort();
    });
    const page = await visit(fixture, '?preview=1&profile=moderation');
    await page.locator('.chat-card[data-entity-id]').first().waitFor();
    await assertNoticeNeverOpened(page);
    assert.ok(blockedNoticeLoads > 0, 'The optional notice chunk failure must be exercised');
    await page.getByRole('navigation').getByRole('link', { name: 'Каналы', exact: true }).click();
    await page.locator('.chats-home--channel').waitFor();
  });
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
