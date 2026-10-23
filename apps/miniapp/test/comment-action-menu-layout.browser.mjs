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

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-action-menu-'));
const server = await ensureMiniappDevServer(base);
let browser;

async function assertStableAction(page, action, label) {
  const geometry = await action.evaluate(async (button) => {
    const samples = [];
    const viewport = document.querySelector('.channel-dialog-body');
    for (let frame = 0; frame < 75; frame++) {
      await new Promise(requestAnimationFrame);
      if (frame < 20) continue;
      const rect = button.getBoundingClientRect();
      samples.push({ x: rect.x, y: rect.y, scroll: viewport.scrollTop });
    }
    const rect = button.getBoundingClientRect();
    const visual = window.visualViewport;
    const minTop = visual?.offsetTop ?? 0;
    const maxBottom = minTop + (visual?.height ?? innerHeight);
    const range = (key) =>
      Math.max(...samples.map((sample) => sample[key])) -
      Math.min(...samples.map((sample) => sample[key]));
    return {
      xRange: range('x'),
      yRange: range('y'),
      scrollRange: range('scroll'),
      withinViewport:
        rect.left >= 0 &&
        rect.right <= innerWidth &&
        rect.top >= minTop &&
        rect.bottom <= maxBottom,
      unobscured: button.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.ok(
    geometry.xRange <= 1 && geometry.yRange <= 1,
    `${label}: moving action ${JSON.stringify(geometry)}`,
  );
  assert.ok(geometry.scrollRange <= 1, `${label}: scrolling feedback ${JSON.stringify(geometry)}`);
  assert.ok(
    geometry.withinViewport && geometry.unobscured,
    `${label}: unreachable action ${JSON.stringify(geometry)}`,
  );
  await page.screenshot({ path: path.join(output, `${label.replaceAll(' ', '-')}.png`) });
  await action.click({ timeout: 3000 });
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [280, 393]) {
    for (const theme of ['light', 'dark']) {
      const label = `${width}px ${theme}`;
      const context = await browser.newContext({
        ...devices[width === 280 ? 'iPhone SE' : 'iPhone 15'],
        viewport: { width, height: width === 280 ? 568 : 703 },
        screen: { width, height: width === 280 ? 568 : 852 },
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      try {
        const blockedApi = [];
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (url.pathname.startsWith('/api/')) {
            if (
              url.pathname === '/api/v1/system/miniapp-boot-trace' &&
              route.request().method() === 'POST'
            )
              return route.fulfill({ status: 204, body: '' });
            blockedApi.push(url.pathname);
            return route.abort();
          }
          return url.origin === new URL(base).origin ? route.continue() : route.abort();
        });
        await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
          route.fulfill({ body: '' }),
        );
        await context.route('**/src/main.tsx', (route) =>
          route.fulfill({
            contentType: 'application/javascript',
            body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
          }),
        );
        const profile = {
          platform: 'ios',
          safeTop: width === 280 ? 20 : 59,
          safeBottom: width === 280 ? 0 : 34,
        };
        await installMaxBridgeShimInitScript(context, profile, { colorScheme: theme });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(base);
        await page.locator('.channel-dialog-message').first().waitFor();
        await applyNativeVisualMode(page, profile);
        await page.evaluate(async () => {
          await window.commentTest.append('Новое длинное сообщение. '.repeat(16));
          await window.commentTest.append('Новое сообщение во время чтения истории');
        });
        await page.waitForFunction(
          () => document.querySelectorAll('.channel-dialog-message').length === 26,
        );
        const body = page.locator('.channel-dialog-body');
        await body.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        assert.ok(
          await body.evaluate((element) => element.scrollHeight > element.clientHeight * 3),
          `${label}: long thread exercised`,
        );
        const field = page.locator('.channel-dialog-compose__field textarea');
        const draft = 'Черновик перед ответом';
        await field.fill(draft);
        await page
          .locator('.channel-dialog-compose input[type="file"]:not([accept])')
          .setInputFiles({
            name: 'draft.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('draft attachment'),
          });
        await page.locator('.channel-dialog-compose__attachment').waitFor();
        const bubble = page.locator('.channel-dialog-message__bubble').last();
        const actions = page.getByRole('dialog', { name: 'Действия с комментарием', exact: true });
        await bubble.press('Enter');
        await assertStableAction(
          page,
          actions.getByRole('button', { name: 'Ответить', exact: true }),
          `${label} reply`,
        );
        await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
        assert.equal(await field.inputValue(), draft);
        assert.equal(await page.locator('.channel-dialog-compose__attachment').count(), 1);
        await bubble.press('Enter');
        await assertStableAction(
          page,
          actions.getByRole('button', { name: 'Изменить', exact: true }),
          `${label} edit`,
        );
        await page.getByRole('button', { name: 'Отменить редактирование', exact: true }).waitFor();
        assert.equal(await field.inputValue(), 'Новое сообщение во время чтения истории');
        await field.fill('Несохранённое изменение');
        await page.getByRole('button', { name: 'Отменить редактирование', exact: true }).click();
        assert.equal(await field.inputValue(), draft);
        assert.equal(await page.locator('.channel-dialog-compose__attachment').count(), 1);

        await context.unroute('**/src/main.tsx');
        await page.goto(
          new URL(
            'channel/preview-channel/dialog/comments?preview=1&device=iphone-se&token=preview-comments-token-0001',
            base,
          ).href,
        );
        await page.locator('.channel-dialog-message').first().waitFor();
        await applyNativeVisualMode(page, profile);
        const text = `Комментарий для реакции ${label}`;
        await field.fill(text);
        await page.getByRole('button', { name: 'Отправить', exact: true }).click();
        const sent = page.locator('.channel-dialog-message.is-own').filter({ hasText: text });
        await sent.waitFor();
        await sent.locator('.channel-dialog-message__bubble').press('Enter');
        const reaction = actions.locator('.channel-dialog-reaction-popover__emoji').first();
        const emoji = await reaction.innerText();
        await assertStableAction(page, reaction, `${label} reaction`);
        await actions.waitFor({ state: 'hidden' });
        const activeReaction = sent.getByRole('button', {
          name: `Реакция ${emoji}: 1`,
          exact: true,
        });
        await activeReaction.waitFor();
        assert.equal(await activeReaction.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(blockedApi, [], `${label}: unexpected API request`);
        assert.deepEqual(errors, [], `${label}: page errors`);
        console.log(`${label}: stable edit/reply on a long thread, preview reaction passed`);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
  console.log(`Screenshots: ${output}`);
}
