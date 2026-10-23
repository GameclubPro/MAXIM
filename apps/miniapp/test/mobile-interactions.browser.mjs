import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local preview required');
for (const device of (process.env.MINIAPP_TEST_DEVICES ?? 'iphone-se,android').split(',')) {
  const capture = resolveCaptureDevice(presets[device]);
  const browser = await { chromium, webkit }[capture.browserName].launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...capture.contextOptions,
        colorScheme: theme,
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ contentType: 'text/javascript', body: '/* preview bridge */' }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.clock.setFixedTime('2026-07-18T09:00:00.000Z');
      const navigate = async (path) => {
        const url = new URL(path.replace(/^\//u, ''), base);
        url.searchParams.set('preview', '1');
        url.searchParams.set('device', device);
        await page.goto(url.href);
        await page.locator('.app-shell').waitFor();
        await applyNativeVisualMode(page, capture.profile);
        await settleVisualFrame(page);
      };

      await navigate('/publications?profile=publisher');
      const toggle = page.getByRole('button', { name: 'Фильтры публикаций', exact: true });
      await toggle.click();
      await page
        .getByRole('group', { name: 'Тип получателя' })
        .getByRole('button', { name: 'Каналы', exact: true })
        .click();
      await toggle.click();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('group', { name: 'Тип получателя' }).count(), 0);
      assert.match(await page.locator('.publications-filterbar__summary').innerText(), /Каналы/u);
      await page.getByRole('button', { name: 'Изменить активные фильтры', exact: true }).click();
      assert.equal(
        await page
          .getByRole('group', { name: 'Тип получателя' })
          .getByRole('button', { name: 'Каналы', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      const card = page.locator('.publication-feed-card__surface').first();
      if (await card.count()) {
        const ids = (await card.getAttribute('aria-describedby')).split(' ');
        assert.ok(ids.length >= 1);
        for (const id of ids) assert.ok(await page.locator(`[id="${id}"]`).innerText());
      }
      await navigate('/?profile=publisher');
      await page.locator('.publisher-entity-row').first().waitFor();
      await page.locator('.publisher-entities-page__search input').focus();
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', {
          configurable: true,
          get: () => window.innerHeight - 240,
        });
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => document.querySelector('.bottom-nav')?.inert === true);
      assert.equal(await page.getByRole('navigation').count(), 0);
      await page.evaluate(() => {
        const link = document.querySelector('.bottom-nav a');
        link.focus();
      });
      assert.equal(
        await page.locator('.bottom-nav').evaluate((nav) => nav.contains(document.activeElement)),
        false,
      );
      await page.route('**/mobile-feedback-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/app/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;
        await import('/app/test/fixtures/mobile-feedback-harness.tsx');</script></body></html>`,
        }),
      );
      await page.goto(new URL('mobile-feedback-test', base).href);
      await page.getByRole('button', { name: 'Диалог', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.textContent === 'Первый');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Закрыть');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Первый');
      await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Диалог');
      await page.getByRole('button', { name: 'Ошибка', exact: true }).click();
      await page.waitForTimeout(3400);
      assert.equal(
        await page.getByRole('alert').count(),
        1,
        'Errors remain available until dismissed',
      );
      await page.evaluate(() => {
        const root = document.documentElement;
        root.dataset.maxKeyboardOpen = 'true';
        root.style.setProperty('--app-keyboard-overlap', '220px');
        root.style.setProperty('--app-viewport-height', `${innerHeight - 220}px`);
      });
      const toast = await page.getByRole('alert').boundingBox();
      assert.ok(
        toast.y >= 0 && toast.y + toast.height <= capture.contextOptions.viewport.height - 220,
      );
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      assert.equal(await page.getByRole('alert').count(), 0);
      await page.getByRole('button', { name: 'Успех', exact: true }).click();
      const status = page.getByRole('status');
      await status.waitFor();
      await status.hover();
      await page.waitForTimeout(700);
      assert.equal(await status.count(), 1, 'Reading a notification pauses dismissal');
      await status.getByRole('button').focus();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(700);
      assert.equal(await status.count(), 1, 'Keyboard focus pauses dismissal');
      await page.getByRole('button', { name: 'Успех', exact: true }).focus();
      await status.waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []);
      console.log(
        `PASS mobile interactions ${device} ${theme}: collapsible filters, context, keyboard, focus, persistent errors`,
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
