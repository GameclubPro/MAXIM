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
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-publication-usability-'));
let browser;

async function assertReachable(locator) {
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      fits:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= (viewport?.offsetTop ?? 0) - 1 &&
        rect.bottom <= (viewport?.height ?? innerHeight) + (viewport?.offsetTop ?? 0) + 1,
      touch: rect.width >= 44 && rect.height >= 44,
      unobscured: element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.deepEqual(result, { fits: true, touch: true, unobscured: true });
}

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device] of [
    ['iphone-se', devices['iPhone SE']],
    ['iphone', devices['iPhone 15']],
    ['android', devices['Pixel 7']],
    ['desktop', { viewport: { width: 1280, height: 900 } }],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({ ...device, colorScheme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        // FLAG: Preview-only flow; no external traffic or real publication is allowed.
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        await installNativeVisualModeInitScript(context);
        await page.goto(`${base}publications?preview=1&profile=publisher`);
        const create = page.getByRole('button', { name: 'Создать публикацию', exact: true });
        await create.waitFor();
        await applyNativeVisualMode(page, {
          safeTop: name.startsWith('iphone') ? 59 : 24,
          safeBottom: name.startsWith('iphone') ? 34 : 0,
        });
        assert.equal(await create.locator('span').isVisible(), true);
        await create.click();
        await page.getByRole('button', { name: 'Написать', exact: true }).click();
        const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
        const primary = page.getByRole('button', { name: 'Проверить пост', exact: true });
        const scroll = page.locator('.publications-editor');
        await editor.waitFor();
        await assertReachable(primary);
        await primary.click();
        await page
          .locator('.publication-submit-feedback')
          .getByText('Добавьте текст, фото или видео.', { exact: true })
          .waitFor();
        assert.equal(await editor.getAttribute('aria-invalid'), 'true');

        const postActions = page.getByRole('button', { name: /После публикации/u });
        assert.equal(await postActions.getAttribute('aria-expanded'), 'false');
        await page.locator('.publication-target-picker__summary').click();
        const picker = page.getByRole('dialog', { name: 'Получатели', exact: true });
        await picker.waitFor();
        await page.waitForFunction(() =>
          document.activeElement?.matches('.publication-target-picker__editor.is-sheet'),
        );
        await picker
          .getByRole('button', { name: 'Выбрать Новости Южного, канал', exact: true })
          .click();
        const done = picker.getByRole('button', { name: 'Завершить выбор получателей' });
        assert.equal(await done.textContent(), 'Готово · 1');
        await assertReachable(done);
        if (name !== 'desktop') {
          await picker
            .getByRole('button', { name: 'Выбрать Садоводы Южного, чат', exact: true })
            .click();
          await picker.getByRole('searchbox').focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(
            () =>
              document
                .querySelector('.publication-target-picker__editor.is-sheet')
                .getBoundingClientRect().height <= 301,
          );
          await assertReachable(done);
          assert.ok(
            await picker
              .locator('.publication-target-picker__list')
              .evaluate((element) => element.clientHeight >= 58),
            'Search keeps at least one recipient row visible',
          );
          await page.evaluate(() => {
            delete visualViewport.height;
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await picker
            .getByRole('button', { name: 'Убрать Садоводы Южного, чат', exact: true })
            .click();
        }
        await done.click();

        const text = Array.from(
          { length: 18 },
          (_, index) =>
            `Абзац ${index + 1}. Проверяем удобство длинного поста и сохранение текста.`,
        ).join('\n\n');
        // Exercise the clipboard handler used by people pasting a prepared post.
        await editor.evaluate((element, content) => {
          element.focus();
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', content);
          element.dispatchEvent(
            new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
          );
        }, text);
        await editor.press('End');
        await editor.pressSequentially(' Дополнение');
        await editor.evaluate((element) => {
          const node = element.firstChild;
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 7);
          const selection = document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
        await page.getByRole('button', { name: 'Жирный', exact: true }).click();
        await editor.locator('strong, b').first().waitFor();
        assert.equal(await editor.locator('strong, b').first().textContent(), 'Абзац 1');
        await page.getByRole('button', { name: 'Форматирование', exact: true }).click();
        const authoredText = await editor.innerText();
        await scroll.evaluate((element) => element.scrollTo({ top: element.scrollHeight / 2 }));
        await assertReachable(primary);
        await assertReachable(page.getByRole('button', { name: 'Форматирование', exact: true }));
        assert.equal(
          await page
            .locator('.publication-content-composer')
            .getByText('Фото', { exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await page
            .locator('.publication-video-tool')
            .getByText('Видео', { exact: true })
            .isVisible(),
          true,
        );
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-long.png` });

        if (name !== 'desktop') {
          await editor.focus();
          await page.evaluate(() => {
            Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page.waitForFunction(() =>
            document.querySelector('.publications-page').classList.contains('is-keyboard-open'),
          );
          await assertReachable(primary);
          await primary.click();
          await page.getByRole('dialog', { name: 'Проверка публикации', exact: true }).waitFor();
          await page.evaluate(() => {
            delete visualViewport.height;
            visualViewport.dispatchEvent(new Event('resize'));
          });
          await page
            .getByRole('dialog', { name: 'Проверка публикации', exact: true })
            .getByRole('button', { name: 'Назад', exact: true })
            .click();
          assert.equal(await editor.innerText(), authoredText);
        }

        await postActions.click();
        await page.getByRole('switch', { name: 'Закрепить пост', exact: true }).check();
        await page.getByRole('switch', { name: 'Удалить автоматически', exact: true }).check();
        await postActions.click();
        assert.match(
          await postActions.textContent(),
          /Закрепить с уведомлением.*Удаление через 1 дн./u,
        );
        await primary.click();
        const review = page.getByRole('dialog', { name: 'Проверка публикации', exact: true });
        await review.waitFor();
        assert.match(await review.locator('.publication-preview__text').textContent(), /Абзац 18/u);
        assert.match(
          await review.locator('.publication-preview__facts').textContent(),
          /Закрепить с уведомлением.*Удаление через 1 дн./u,
        );
        await assertReachable(review.getByRole('button', { name: 'Опубликовать', exact: true }));
        await review.getByRole('button', { name: 'Назад', exact: true }).click();
        assert.equal(await editor.innerText(), authoredText);
        await primary.click();
        await review.getByRole('button', { name: 'Опубликовать', exact: true }).click();
        await page.locator('.publications-page:not(.is-editor)').waitFor();
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}-${colorScheme}: create, targets, long text, keyboard, options, review, preview publish`,
        );
      } catch (error) {
        await page.screenshot({ path: `${output}/${name}-${colorScheme}-failure.png` });
        throw error;
      } finally {
        await context.close();
      }
    }
  }
} finally {
  console.log(`Screenshots: ${output}`);
  await browser?.close();
  await stopChildProcess(server);
}
