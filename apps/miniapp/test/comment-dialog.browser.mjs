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
    name: 'android-gesture',
    device: devices['Pixel 7'],
    platform: 'android',
    safeTop: 24,
    safeBottom: 24,
  },
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
      dockPaintsBottom: Boolean(
        document
          .elementFromPoint(innerWidth / 2, visibleBottom - 1)
          ?.closest('.channel-dialog-compose'),
      ),
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
  assert.ok(metrics.dockPaintsBottom, `${state}: wallpaper visible below composer`);
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
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

      const dock = page.locator('.channel-dialog-compose');
      const readBottomPadding = () =>
        dock.evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom));
      assert.equal(await readBottomPadding(), Math.max(8, profile.safeBottom));
      if (profile.safeBottom > 0) {
        await page.evaluate(
          (inset) =>
            document.documentElement.style.setProperty(
              '--app-layout-viewport-bottom',
              `${inset}px`,
            ),
          profile.safeBottom,
        );
        assert.equal(
          await readBottomPadding(),
          8,
          'MAX-reserved safe area must not be counted twice',
        );
        await assertLatestVisible(page, 'native-reserved bottom inset');
        await page.evaluate(() =>
          document.documentElement.style.setProperty('--app-layout-viewport-bottom', '0px'),
        );
      }

      const lastBubble = page.locator('.channel-dialog-message__bubble').last();
      const actions = page.getByRole('dialog', { name: 'Действия с комментарием', exact: true });
      if (profile.device.hasTouch) {
        const touch = await context.newCDPSession(page);
        const bounds = await lastBubble.boundingBox();
        await touch.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: bounds.x + 24, y: bounds.y + 24 }],
        });
        await actions.waitFor();
        await page.waitForTimeout(700);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await touch.detach();
      } else {
        await lastBubble.press('Enter');
      }
      await actions.waitFor();
      assert.equal(
        await page.evaluate(() => document.getSelection()?.isCollapsed),
        true,
        'holding a comment does not select text',
      );
      const nativeMenu = await actions.evaluate((element) => {
        const button = element.querySelector('.channel-dialog-reaction-popover__action');
        const selectionAllowed = button.dispatchEvent(
          new Event('selectstart', { bubbles: true, cancelable: true }),
        );
        const contextMenuAllowed = button.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
        );
        const protectedLabels = [...element.querySelectorAll('*')].every(
          (node) => getComputedStyle(node).userSelect === 'none',
        );
        const range = document.createRange();
        range.selectNodeContents(button);
        document.getSelection().addRange(range);
        return { selectionAllowed, contextMenuAllowed, protectedLabels };
      });
      assert.deepEqual(nativeMenu, {
        selectionAllowed: false,
        contextMenuAllowed: false,
        protectedLabels: true,
      });
      await page.waitForFunction(() => document.getSelection()?.isCollapsed);
      await page.screenshot({ path: path.join(output, `${profile.name}-${mode}-held-menu.png`) });
      const replyAction = actions.getByRole('button', { name: 'Ответить', exact: true });
      if (profile.device.hasTouch) await replyAction.tap();
      else await replyAction.click();
      await actions.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
      assert.equal(
        await lastBubble.locator('a').evaluate((element) => getComputedStyle(element).userSelect),
        'none',
        'links do not re-enable the native long-press menu',
      );
      await field.fill('Выделение в черновике доступно');
      const draftSelection = await field.evaluate((element) => {
        element.setSelectionRange(0, 9);
        return {
          selected: element.selectionEnd - element.selectionStart,
          selectionAllowed: element.dispatchEvent(
            new Event('selectstart', { bubbles: true, cancelable: true }),
          ),
          contextMenuAllowed: element.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
          ),
          userSelect: getComputedStyle(element).userSelect,
        };
      });
      assert.equal(draftSelection.selected, 9);
      assert.ok(
        draftSelection.selectionAllowed &&
          draftSelection.contextMenuAllowed &&
          draftSelection.userSelect !== 'none',
        'draft keeps native selection and paste',
      );
      await field.fill('');
      await field.blur();
      if (profile.device.hasTouch) {
        const touch = await context.newCDPSession(page);
        const bounds = await body.boundingBox();
        const previousTop = await body.evaluate((element) => element.scrollTop);
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        for (let distance = 20; distance <= 120; distance += 20) {
          await touch.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: point.x, y: point.y + distance }],
          });
          await page.waitForTimeout(20);
        }
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForFunction(
          (previousTop) =>
            document.querySelector('.channel-dialog-body').scrollTop < previousTop - 40,
          previousTop,
        );
        assert.equal(await actions.count(), 0, 'vertical scrolling must not open message actions');
        // Let the native fling settle before testing the separate jump-to-latest command.
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: 'К последнему комментарию', exact: true }).click();
        await touch.detach();
        await assertLatestVisible(page, 'native touch scroll');
      }

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

      await field.fill('Черновик перед ответом');
      await page.locator('.channel-dialog-compose input[type="file"]:not([accept])').setInputFiles({
        name: 'draft.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('draft attachment'),
      });
      await page.locator('.channel-dialog-compose__attachment').waitFor();
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Ответить', exact: true }).click();
      assert.equal(
        await field.inputValue(),
        'Черновик перед ответом',
        'reply preserves the existing draft',
      );
      assert.equal(
        await page.locator('.channel-dialog-compose__attachment').count(),
        1,
        'reply preserves attachments',
      );
      await assertLatestVisible(page, 'reply strip');
      await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Изменить', exact: true }).click();
      await field.fill('Несохранённое изменение');
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Ответить', exact: true }).click();
      assert.equal(
        await field.inputValue(),
        'Черновик перед ответом',
        'reply from editing restores the original draft',
      );
      assert.equal(await page.locator('.channel-dialog-compose__attachment').count(), 1);
      await page.getByRole('button', { name: 'Отменить ответ', exact: true }).click();
      await page.locator('.channel-dialog-compose__attachment-dismiss').click();

      await page.evaluate(() => {
        window.commentCopiedText = null;
        window.readCommentClipboard = navigator.clipboard.readText.bind(navigator.clipboard);
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.commentCopiedText = text;
            },
          },
        });
      });
      const copyText = await page
        .locator('.channel-dialog-message__bubble')
        .last()
        .locator('p')
        .allTextContents();
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Копировать', exact: true }).click();
      await actions.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.commentCopiedText), copyText.join('\n'));
      assert.equal(await field.inputValue(), 'Черновик перед ответом');
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      });
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Копировать', exact: true }).click();
      await actions.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => window.readCommentClipboard()), copyText.join('\n'));
      assert.equal(
        await page.locator('textarea').count(),
        1,
        'legacy copy removes its temporary field',
      );
      assert.equal(await field.inputValue(), 'Черновик перед ответом');
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      await page.evaluate(() =>
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async () => {
              throw new Error('denied');
            },
          },
        }),
      );
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Копировать', exact: true }).click();
      await page.getByText('Не удалось скопировать текст', { exact: true }).waitFor();
      await actions.waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();

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
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Показать больше реакций', exact: true }).click();
      await page.waitForFunction(() => {
        const menu = document
          .querySelector('.channel-dialog-reaction-popover')
          .getBoundingClientRect();
        const header = document
          .querySelector('.channel-dialog-comments-header')
          .getBoundingClientRect();
        const composer = document.querySelector('.channel-dialog-compose').getBoundingClientRect();
        return menu.top >= header.bottom && menu.bottom <= composer.top;
      });
      await page.screenshot({
        path: path.join(output, `${profile.name}-${mode}-keyboard-menu.png`),
      });
      await page.keyboard.press('Escape');
      await field.focus();
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
        `PASS ${profile.name} ${mode}: edge-to-edge dock, native insets, long press, selection, scroll, unread, replies, edits, send failure, files, keyboards, empty state`,
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
