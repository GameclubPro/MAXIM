import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = process.env.COMMENT_DIALOG_BASE_URL || 'http://127.0.0.1:3014/app/';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-dialog-'));
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
const profiles = [
  { name: 'iphone-se', device: devices['iPhone SE'], platform: 'ios', safeTop: 20, safeBottom: 0 },
  { name: 'iphone', device: devices['iPhone 15'], platform: 'ios', safeTop: 59, safeBottom: 34 },
  { name: 'android', device: devices['Pixel 7'], platform: 'android', safeTop: 24, safeBottom: 0 },
  {
    name: 'desktop',
    device: { viewport: { width: 1280, height: 900 } },
    platform: 'web',
    safeTop: 0,
    safeBottom: 0,
  },
];
let activePage;

async function assertLatestVisible(page, state) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.waitForFunction(() => {
    const body = document.querySelector('.channel-dialog-body');
    return body.scrollHeight - body.clientHeight - body.scrollTop < 2;
  });
  const metrics = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const last = rect('.channel-dialog-message:last-child');
    const body = rect('.channel-dialog-body');
    const composer = rect('.channel-dialog-compose');
    const header = rect('.channel-dialog-comments-header');
    const visibleBottom = visualViewport.height + visualViewport.offsetTop;
    return {
      gap: composer.top - last.bottom,
      headerGap: body.top - header.bottom,
      bodyGap: composer.top - body.bottom,
      composerOverflow: composer.bottom - visibleBottom,
      composerWidth: composer.width,
      viewportWidth: innerWidth,
      lastTop: last.top,
      bodyTop: body.top,
      lastHeight: last.height,
      bodyHeight: body.height,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
  assert.ok(
    metrics.gap >= 12,
    `${state}: last comment needs an end gap: ${JSON.stringify(metrics)}`,
  );
  assert.ok(metrics.headerGap >= -1 && metrics.bodyGap >= -1, `${state}: regions overlap`);
  assert.ok(metrics.composerOverflow <= 1, `${state}: composer outside visual viewport`);
  assert.ok(
    Math.abs(metrics.composerOverflow) <= 1,
    `${state}: gap below the composer: ${JSON.stringify(metrics)}`,
  );
  assert.ok(
    Math.abs(metrics.composerWidth - metrics.viewportWidth) <= 1,
    `${state}: composer is not full width`,
  );
  assert.ok(metrics.horizontalOverflow <= 1, `${state}: horizontal overflow`);
  assert.ok(metrics.bodyHeight >= 64, `${state}: composer leaves no usable message area`);
  if (metrics.lastHeight + 16 <= metrics.bodyHeight)
    assert.ok(metrics.lastTop >= metrics.bodyTop - 1, `${state}: short last comment clipped`);
}

try {
  for (const profile of profiles) {
    if (
      process.env.COMMENT_DIALOG_DEVICES &&
      !process.env.COMMENT_DIALOG_DEVICES.split(',').includes(profile.name)
    )
      continue;
    for (const mode of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
        colorScheme: mode,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
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
      await installMaxBridgeShimInitScript(context, profile, { colorScheme: mode });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      await page.locator('.channel-dialog-message').first().waitFor();
      await applyNativeVisualMode(page, profile);
      const field = page.locator('.channel-dialog-compose__field textarea');
      const body = page.locator('.channel-dialog-body');
      await assertLatestVisible(page, 'initial');
      const tools = page.getByRole('button', { name: 'Вложения и эмодзи', exact: true });
      assert.equal(await tools.getAttribute('aria-expanded'), 'false');
      const dockHeight = await page
        .locator('.channel-dialog-compose')
        .evaluate((element) => element.clientHeight);
      assert.ok(dockHeight <= 68 + profile.safeBottom, 'idle composer stays compact');
      await tools.click();
      await page.getByRole('button', { name: 'Эмодзи', exact: true }).waitFor();
      await assertLatestVisible(page, 'expanded tools');
      await page.keyboard.press('Escape');
      assert.equal(await tools.getAttribute('aria-expanded'), 'false');
      assert.ok(await tools.evaluate((element) => element === document.activeElement));
      assert.equal(await page.getByLabel('Комментариев: 24', { exact: true }).textContent(), '24');
      await page.evaluate(() => window.commentTest.setTruncated(true));
      await page.getByLabel('Комментариев: больше 24', { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel('Комментариев: больше 24', { exact: true }).textContent(),
        '24+',
      );
      await page.evaluate(() => window.commentTest.setTruncated(false));
      assert.ok((await page.locator('.channel-dialog-message__grouped-time').count()) > 0);
      assert.equal(await page.locator('.channel-dialog-day').count(), 1);

      await field.fill(
        'Многострочный комментарий\nВторая строка\nТретья строка\nЧетвёртая строка\nПятая строка',
      );
      await assertLatestVisible(page, 'growing draft');
      await field.fill('');
      await assertLatestVisible(page, 'shrinking draft');
      assert.equal(await tools.getAttribute('aria-expanded'), 'false');

      await page.evaluate(() => window.commentTest.append('Новое длинное сообщение. '.repeat(16)));
      await page.waitForFunction(
        () => document.querySelectorAll('.channel-dialog-message').length === 25,
      );
      await assertLatestVisible(page, 'incoming tall comment while at bottom');
      await body.evaluate((element) => {
        element.scrollTop = 60;
      });
      await page.getByRole('button', { name: 'К последнему комментарию', exact: true }).waitFor();
      const oldTop = await body.evaluate((element) => element.scrollTop);
      await page.evaluate(() =>
        window.commentTest.append('Новое сообщение во время чтения истории'),
      );
      await page.getByRole('button', { name: 'Перейти к 1 новым комментариям' }).waitFor();
      assert.ok(
        Math.abs((await body.evaluate((element) => element.scrollTop)) - oldTop) <= 1,
        'incoming comments must not move the reader',
      );
      await page.getByRole('button', { name: 'Перейти к 1 новым комментариям' }).click();
      await assertLatestVisible(page, 'jump to unread');

      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Ответить', exact: true }).click();
      await assertLatestVisible(page, 'reply strip');
      await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();

      await field.fill('Черновик до редактирования');
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Изменить', exact: true }).click();
      await field.fill('Исправленный комментарий');
      await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await page.waitForFunction(
        () => document.querySelector('textarea').value === 'Черновик до редактирования',
      );
      await assertLatestVisible(page, 'edit restores draft');

      await page.evaluate(() => window.commentTest.holdSend());
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea').readOnly);
      assert.equal(await field.inputValue(), 'Черновик до редактирования');
      await page.evaluate(() => window.commentTest.finishSend(true));
      await page.waitForFunction(() => !document.querySelector('textarea').readOnly);
      assert.equal(
        await field.inputValue(),
        'Черновик до редактирования',
        'failed sends retain the draft',
      );
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      await page.getByRole('button', { name: 'Отправить', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('textarea').value === '');
      await assertLatestVisible(page, 'send');

      await page.locator('.channel-dialog-compose input[type="file"]:not([accept])').setInputFiles([
        { name: 'document-one.txt', mimeType: 'text/plain', buffer: Buffer.from('one') },
        { name: 'document-two.txt', mimeType: 'text/plain', buffer: Buffer.from('two') },
      ]);
      await page.locator('.channel-dialog-compose__attachment').first().waitFor();
      await assertLatestVisible(page, 'files');
      const viewport = page.viewportSize();
      await field.fill('С открытой клавиатурой\nВторая строка\nТретья строка');
      await page.setViewportSize({ width: viewport.width, height: 360 });
      await assertLatestVisible(page, 'resize keyboard with files');
      assert.ok(
        await field.evaluate((element) => element.scrollTop > 0),
        'end caret remains visible after keyboard resize',
      );
      await page.screenshot({ path: path.join(output, `${profile.name}-${mode}-keyboard.png`) });
      while (await page.locator('.channel-dialog-compose__attachment-dismiss').count())
        await page.locator('.channel-dialog-compose__attachment-dismiss').first().click();
      await field.fill('');
      await page.setViewportSize(viewport);
      await assertLatestVisible(page, 'keyboard closes');

      await field.focus();
      await page.evaluate(() => {
        Object.defineProperty(visualViewport, 'height', { configurable: true, value: 340 });
        Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 16 });
        visualViewport.dispatchEvent(new Event('resize'));
        visualViewport.dispatchEvent(new Event('scroll'));
      });
      await assertLatestVisible(page, 'visual viewport keyboard');
      await page.evaluate(() => {
        delete visualViewport.height;
        delete visualViewport.offsetTop;
        visualViewport.dispatchEvent(new Event('resize'));
        visualViewport.dispatchEvent(new Event('scroll'));
      });
      await field.blur();
      await assertLatestVisible(page, 'visual viewport restored');
      await page.screenshot({ path: path.join(output, `${profile.name}-${mode}.png`) });
      await field.fill('Отправка с клавиатуры');
      await field.press('Control+Enter');
      await page.waitForFunction(() => document.querySelector('textarea').value === '');
      await assertLatestVisible(page, 'keyboard send');
      await page.evaluate(() => window.commentTest.empty());
      await page.getByText('Комментариев пока нет', { exact: true }).waitFor();
      await page.evaluate(() => window.commentTest.append('Первый комментарий'));
      await page.getByText('Первый комментарий', { exact: true }).waitFor();
      await assertLatestVisible(page, 'first comment');
      assert.deepEqual(errors, [], 'browser errors');
      console.log(
        `PASS ${profile.name} ${mode}: end gap, scroll, unread, replies, edits, send failure, files, keyboards, empty state`,
      );
      await context.close();
    }
  }
} catch (error) {
  if (activePage && !activePage.isClosed())
    await activePage.screenshot({ path: path.join(output, 'failure.png') });
  throw error;
} finally {
  console.log(`Screenshots: ${output}`);
  await browser.close();
  await stopChildProcess(server);
}
