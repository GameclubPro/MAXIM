import assert from 'node:assert/strict';
import { chromium } from 'playwright';
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

const base =
  process.env.COMMENT_HEADER_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.COMMENT_HEADER_REUSE_SERVER === '1',
});
let browser;

try {
  browser = await chromium.launch();
  for (const width of [280, 320, 393]) {
    for (const theme of ['light', 'dark']) {
      for (const entity of ['chat', 'channel']) {
        const context = await browser.newContext({
          viewport: { width, height: 703 },
          colorScheme: theme,
          isMobile: true,
          hasTouch: true,
          reducedMotion: 'reduce',
        });
        try {
          await installNativeVisualModeInitScript(context);
          await installMaxBridgeShimInitScript(
            context,
            { platform: 'ios' },
            { colorScheme: theme },
          );
          await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
            route.fulfill({ body: '' }),
          );
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(
            new URL(
              `${entity}/preview-${entity}/dialog/comments?preview=1&token=preview-comments-token-0001`,
              base,
            ).href,
          );
          await page.getByRole('button', { name: 'Ограничения участников', exact: true }).waitFor();
          await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
          if (width <= 340) {
            await page.locator('.channel-dialog-comments-header__eyebrow').evaluate((element) => {
              element.textContent = 'Обсуждение поста сообщества с очень длинным названием';
            });
          }
          await page
            .locator('.channel-dialog-compose__field textarea')
            .fill('Комментарий для проверки адаптивной формы и переноса текста.');
          const metrics = await page.evaluate(() => {
            const header = document.querySelector('.channel-dialog-comments-header');
            const title = header.querySelector('h1');
            const range = document.createRange();
            range.selectNodeContents(title);
            const bounds = header.getBoundingClientRect();
            const context = header
              .querySelector('.channel-dialog-comments-header__context')
              .getBoundingClientRect();
            const buttons = [...header.querySelectorAll('button')].map((button) =>
              button.getBoundingClientRect(),
            );
            const field = document
              .querySelector('.channel-dialog-compose__field textarea')
              .getBoundingClientRect();
            const composer = document
              .querySelector('.channel-dialog-compose')
              .getBoundingClientRect();
            return {
              title: title.textContent,
              lines: range.getClientRects().length,
              titleFits: title.scrollWidth <= title.clientWidth + 1,
              font: getComputedStyle(title).fontSize,
              contextInside: context.top >= bounds.top && context.bottom <= bounds.bottom,
              buttons: buttons.map((button) => [button.width, button.height]),
              noOverlap:
                context.right <= buttons[0].left &&
                buttons.every((button, index) => !index || button.left >= buttons[index - 1].right),
              overflow: document.documentElement.scrollWidth - innerWidth,
              fieldInside: field.left >= 0 && field.right <= innerWidth,
              composerInside: composer.bottom <= innerHeight + 1,
            };
          });
          const label = `${width}px ${theme} ${entity}`;
          assert.equal(metrics.title, 'Комментарии', label);
          assert.equal(metrics.lines, 1, `${label}: title wraps`);
          assert.equal(metrics.titleFits, true, `${label}: title is clipped`);
          assert.equal(metrics.contextInside, true, `${label}: context leaves the header`);
          assert.equal(metrics.buttons.length, 3, `${label}: all header actions are exercised`);
          assert.ok(
            metrics.buttons.every(([w, h]) => w >= 44 && h >= 44),
            label,
          );
          assert.equal(metrics.noOverlap, true, `${label}: header controls overlap`);
          assert.ok(metrics.overflow <= 1, `${label}: horizontal overflow`);
          assert.equal(metrics.fieldInside, true, `${label}: composer field leaves the viewport`);
          assert.equal(metrics.composerInside, true, `${label}: composer leaves the viewport`);
          if (width === 393) assert.equal(metrics.font, '17px', label);
          assert.deepEqual(errors, [], label);
          console.log(`PASS ${label}: complete title, three touch targets and composer`);
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
