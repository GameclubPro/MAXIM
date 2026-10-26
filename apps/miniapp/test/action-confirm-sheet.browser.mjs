import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice } from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local preview required');

for (const device of ['iphone-se', 'android']) {
  const capture = resolveCaptureDevice(presets[device]);
  const browser = await { chromium, webkit }[capture.browserName].launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    for (const theme of ['light', 'dark']) {
      for (const profile of ['moderation', 'publisher']) {
        const context = await browser.newContext({
          ...capture.contextOptions,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        await context.addInitScript(
          ({ theme, profile }) => {
            window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
            document.addEventListener('DOMContentLoaded', () => {
              document.documentElement.dataset.maxTheme = theme;
              document.body.dataset.miniappProfile = profile;
            });
          },
          { theme, profile },
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route('**/confirmation-viewport-test', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
              import RefreshRuntime from '/app/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
              window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;
              await import('/app/test/fixtures/action-confirm-sheet-harness.tsx');</script></body></html>`,
          }),
        );
        await page.goto(new URL('confirmation-viewport-test', base).href);
        const openButton = page.getByRole('button', { name: 'Открыть подтверждение', exact: true });
        const confirmButton = page.getByRole('button', { name: 'Не сохранять', exact: true });
        const panel = page.getByRole('dialog');
        await openButton.click();
        await page.waitForFunction(
          () => document.activeElement?.textContent === 'Продолжить настройку',
        );
        await page.keyboard.press('Shift+Tab');
        assert.equal(
          await page.evaluate(() => document.activeElement?.textContent),
          'Не сохранять',
        );

        const checkLayout = async ({ top, height, fontSize }) => {
          await page.evaluate(
            ({ top, height, fontSize }) => {
              document.documentElement.style.fontSize = `${fontSize}px`;
              document.documentElement.style.setProperty('--app-keyboard-overlap', '360px');
              Object.defineProperties(window.visualViewport, {
                offsetTop: { configurable: true, get: () => top },
                offsetLeft: { configurable: true, get: () => 0 },
                height: { configurable: true, get: () => height },
                width: { configurable: true, get: () => window.innerWidth },
              });
              window.visualViewport.dispatchEvent(new Event('resize'));
              window.visualViewport.dispatchEvent(new Event('scroll'));
            },
            { top, height, fontSize },
          );
          await page.waitForFunction(
            ({ top, height }) => {
              const rect = document.querySelector('.action-confirm-sheet')?.getBoundingClientRect();
              return rect && Math.abs(rect.top - top) < 1 && Math.abs(rect.height - height) < 1;
            },
            { top, height },
          );
          const geometry = await panel.evaluate((element) => {
            element.scrollTop = 0;
            const rect = element.getBoundingClientRect();
            return {
              top: rect.top,
              bottom: rect.bottom,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            };
          });
          assert.ok(geometry.top >= top - 1, JSON.stringify(geometry));
          assert.ok(geometry.bottom <= top + height + 1, JSON.stringify(geometry));
          assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'Long names must wrap');
          assert.ok(
            geometry.scrollHeight > geometry.clientHeight,
            'Long content remains scrollable',
          );
          await panel.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const actionRect = await confirmButton.boundingBox();
          assert.ok(
            actionRect.y >= top - 1 && actionRect.y + actionRect.height <= top + height + 1,
          );
        };

        await checkLayout({ top: 64, height: 280, fontSize: 16 });
        await checkLayout({ top: 90, height: 250, fontSize: 32 });
        await page.setViewportSize({ width: 667, height: 320 });
        await checkLayout({ top: 0, height: 320, fontSize: 32 });
        await confirmButton.click();
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await page.getByLabel('Результат').textContent(), 'Подтверждено');
        await page.waitForFunction(
          () => document.activeElement?.textContent === 'Открыть подтверждение',
        );
        assert.equal(await page.evaluate(() => document.body.style.overflow), '');
        assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
        assert.deepEqual(errors, []);
        console.log(
          `PASS confirmation viewport ${device} ${theme} ${profile}: keyboard, offset, long names, 200% text, landscape, actions, focus`,
        );
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}
