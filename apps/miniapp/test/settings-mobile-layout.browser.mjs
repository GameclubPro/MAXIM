import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local preview required');
const longTitle =
  'Садоводческое товарищество Южного района — официальная группа собственников земельных участков';

for (const engine of [chromium, webkit]) {
  const browser = await engine.launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    for (const width of [320, 393, 412]) {
      for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({
          viewport: { width, height: 667 },
          isMobile: true,
          hasTouch: true,
          colorScheme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === base.origin
              ? route.continue()
              : route.abort(),
          );
          await installMaxBridgeShimInitScript(context, {}, { colorScheme });
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          for (const entity of ['chat/preview-chat', 'channel/preview-channel']) {
            await page.goto(new URL(`${entity}/settings?preview=1`, base).href);
            const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
            await search.waitFor();
            await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
            const title = page.locator('.compact-page-header__title');
            // Exercise user-generated content without changing the preview catalog.
            await title.evaluate((node, text) => {
              node.textContent = text;
            }, longTitle);
            await page.evaluate(() => document.fonts.ready);
            const titleSize = await title.evaluate((node) => ({
              scroll: node.scrollHeight,
              height: node.clientHeight,
            }));
            assert.ok(
              titleSize.scroll <= titleSize.height + 3,
              `${engine.name()}/${width}/${entity}: full community name must remain readable ${JSON.stringify(titleSize)}`,
            );
            await search.fill('несуществующая настройка');
            assert.equal(
              await page.getByRole('button', { name: 'Очистить поиск', exact: true }).count(),
              1,
            );
            for (const fontSize of ['16px', '32px']) {
              await page.evaluate((size) => {
                document.documentElement.style.fontSize = size;
              }, fontSize);
              const empty = page.getByRole('status').filter({ hasText: 'Ничего не найдено' });
              assert.ok(await empty.isVisible());
              assert.ok(await empty.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
              const reset = page.getByRole('button', { name: 'Сбросить поиск', exact: true });
              assert.ok(
                await reset.evaluate((node) => {
                  const button = node.getBoundingClientRect();
                  const container = node.parentElement.getBoundingClientRect();
                  return button.left >= container.left && button.right <= container.right + 1;
                }),
              );
            }
            await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
            assert.equal(await search.inputValue(), '');
            assert.ok(await search.evaluate((node) => document.activeElement === node));
            await search.blur();
            await page.evaluate(() => (document.documentElement.style.fontSize = '16px'));
            const last = page
              .locator('.settings-overview-group .settings-section__toggle:visible')
              .last();
            await last.scrollIntoViewIfNeeded();
            assert.ok(
              await last.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const nav = document.querySelector('.bottom-nav')?.getBoundingClientRect();
                return rect.top >= 0 && rect.bottom <= (nav?.top ?? innerHeight) + 1;
              }),
              'The last settings row must scroll above bottom navigation',
            );
          }
          console.log(`[mobile-settings] ${engine.name()} ${width}px ${colorScheme}: passed`);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}
