import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import {
  captureBrowserLaunchOptions,
  setPhoneKeyboard,
} from '../../../scripts/miniapp-smartphone.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: Boolean(process.env.MINIAPP_TEST_BASE_URL),
});
const browserType = process.env.MINIAPP_TEST_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch(captureBrowserLaunchOptions(browserType.name(), base));

async function nativeBack(page) {
  return page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const { runNativeBackHandlers } = await import('/app/src/lib/native-back.ts');
    return runNativeBackHandlers();
  });
}

try {
  for (const [width, colorScheme] of [
    [320, 'light'],
    [393, 'dark'],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 504 },
      colorScheme,
      reducedMotion: 'reduce',
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await page.route('**/publication-mobile-editors-test*', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;
          await import('/app/test/fixtures/publication-mobile-editors-harness.tsx');</script></body></html>`,
        }),
      );
      await page.goto(`${base}publication-mobile-editors-test`);
      await page.bringToFront();
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      const sheet = page.getByRole('dialog', { name: 'Кнопки', exact: true });
      const guard = page.getByRole('alertdialog', { name: 'Закрыть без сохранения?', exact: true });
      const open = async () => {
        await page.getByRole('button', { name: 'Редактировать кнопки', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.activeElement ===
            document.querySelector('.publication-buttons-sheet input[type="text"]'),
        );
      };

      await open();
      await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(
        await guard.count(),
        0,
        'The synthetic empty row must open without a dirty guard.',
      );

      for (const mode of ['visual', 'resize']) {
        await open();
        await page.waitForFunction(() =>
          document.activeElement?.matches('.publication-buttons-sheet input[type="text"]'),
        );
        const url = sheet.getByRole('textbox', { name: 'Ссылка', exact: true });
        await url.focus();
        for (let cycle = 0; cycle < 3; cycle += 1) {
          await page.evaluate(() => {
            document.documentElement.dataset.maxKeyboardOpen = 'true';
          });
          await setPhoneKeyboard(page, { height: 320, mode });
          await page.waitForFunction(() => {
            const active = document.activeElement;
            const body = document.querySelector('.publication-buttons-sheet__body');
            const done = document.querySelector('.publication-buttons-sheet__done');
            if (!(active instanceof HTMLInputElement) || !body || !done) return false;
            const fields = [...document.querySelectorAll('.publication-buttons-sheet input')].map(
              (field) => field.getBoundingClientRect(),
            );
            const scroller = body.getBoundingClientRect();
            const action = done.getBoundingClientRect();
            return (
              fields.every(
                (field) => field.top >= scroller.top && field.bottom <= scroller.bottom,
              ) && action.bottom <= (visualViewport?.height ?? innerHeight)
            );
          });
          assert.equal(await url.evaluate((element) => document.activeElement === element), true);
          await setPhoneKeyboard(page, { mode, open: false });
          await page.evaluate(() => {
            delete document.documentElement.dataset.maxKeyboardOpen;
          });
          await page.waitForFunction(() =>
            [...document.querySelectorAll('.publication-buttons-sheet input')].every((field) => {
              const rect = field.getBoundingClientRect();
              return rect.top >= 0 && rect.bottom <= (visualViewport?.height ?? innerHeight);
            }),
          );
        }
        await nativeBack(page);
        await sheet.waitFor({ state: 'hidden' });
      }

      await open();
      await sheet.getByRole('button', { name: 'Убрать кнопку 1', exact: true }).click();
      await nativeBack(page);
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(
        await guard.count(),
        0,
        'Removing an untouched synthetic row must not warn about lost changes.',
      );
      await open();
      await sheet.getByRole('button', { name: 'Ещё', exact: true }).click();
      await nativeBack(page);
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(
        await guard.count(),
        0,
        'Adding a blank row without entering values must not warn about lost changes.',
      );

      for (const close of ['x', 'backdrop', 'escape', 'native']) {
        await open();
        await sheet.getByRole('textbox', { name: 'Название', exact: true }).fill('Мой каталог');
        if (close === 'x')
          await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
        else if (close === 'backdrop')
          await page.locator('.publication-buttons-sheet__backdrop').first().dispatchEvent('click');
        else if (close === 'escape') await page.keyboard.press('Escape');
        else assert.equal(await nativeBack(page), true);
        await guard.waitFor();
        assert.equal(
          await guard
            .getByRole('button', { name: 'Продолжить редактирование', exact: true })
            .evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return element.contains(
                document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
              );
            }),
          true,
          'The confirmation must be the touchable upper layer.',
        );
        if (close === 'native') await nativeBack(page);
        else await page.keyboard.press('Escape');
        await guard.waitFor({ state: 'hidden' });
        assert.equal(
          await sheet.getByRole('textbox', { name: 'Название', exact: true }).inputValue(),
          'Мой каталог',
        );
        assert.equal(await page.getByLabel('Применённые кнопки').textContent(), '[]');
        await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click();
        await guard.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await sheet.waitFor({ state: 'hidden' });
        assert.equal(
          await page.evaluate(() => document.body.style.overflow),
          '',
          'Closing both layers must release the body scroll lock.',
        );
      }

      await open();
      await sheet.getByRole('textbox', { name: 'Название', exact: true }).fill('Другой текст');
      await sheet.getByRole('textbox', { name: 'Название', exact: true }).fill('Открыть');
      await nativeBack(page);
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(
        await guard.count(),
        0,
        'Reverting to the opening snapshot must clear dirty state.',
      );

      await open();
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await sheet.locator('[aria-invalid="true"]').first().waitFor();
      assert.equal(await page.getByLabel('Количество сохранений').textContent(), '0');
      await sheet
        .getByRole('textbox', { name: 'Ссылка', exact: true })
        .fill('https://example.com/catalog');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(await page.getByLabel('Количество сохранений').textContent(), '1');
      await open();
      await sheet.getByRole('button', { name: 'Убрать кнопку 1', exact: true }).click();
      await nativeBack(page);
      await guard.waitFor();
      await guard.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      await open();
      assert.equal(
        await sheet.getByRole('textbox', { name: 'Ссылка', exact: true }).inputValue(),
        'https://example.com/catalog',
      );
      await nativeBack(page);
      await sheet.waitFor({ state: 'hidden' });

      await open();
      await sheet.getByRole('button', { name: 'Ещё', exact: true }).click();
      await sheet.getByRole('textbox', { name: 'Название кнопки 2', exact: true }).fill('Вторая');
      await sheet
        .getByRole('textbox', { name: 'Ссылка кнопки 2', exact: true })
        .fill('https://example.com/second');
      await sheet.getByRole('button', { name: 'Переместить кнопку 2 выше', exact: true }).click();
      assert.equal(
        await sheet.getByRole('textbox', { name: 'Название', exact: true }).inputValue(),
        'Вторая',
      );
      await sheet.getByRole('button', { name: 'Переместить кнопку 1 ниже', exact: true }).click();
      await sheet.getByRole('button', { name: 'Убрать кнопку 2', exact: true }).click();
      await nativeBack(page);
      await sheet.waitFor({ state: 'hidden' });
      assert.equal(
        await guard.count(),
        0,
        'Reordering and restoring the opening list must clear dirty state.',
      );

      await page.locator('.publication-target-picker__summary').click();
      const picker = page.locator('.publication-target-picker__editor');
      const search = picker.getByRole('searchbox', { name: 'Найти получателя', exact: true });
      await page.waitForFunction(
        () =>
          document.activeElement === document.querySelector('.publication-target-picker__editor'),
      );
      await search.fill('Канал 1');
      await picker.getByRole('button', { name: 'Очистить: Найти получателя', exact: true }).click();
      assert.equal(await search.inputValue(), '');
      assert.equal(await search.evaluate((element) => document.activeElement === element), true);
      await search.blur();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const list = picker.locator('.publication-target-picker__list');
      await page.waitForFunction(
        () =>
          document.querySelector('.publication-target-picker__virtual-spacer')?.style.height ===
          '15200px',
      );
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await picker.locator('.publication-target-row').filter({ hasText: 'Канал 200 ·' }).waitFor();
      const last = picker.locator('.publication-target-row').filter({ hasText: 'Канал 200 ·' });
      assert.equal(await last.evaluate((element) => element.getBoundingClientRect().height), 76);
      await last.click();
      assert.equal(await last.getAttribute('aria-pressed'), 'true');
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await page.waitForFunction(
        () =>
          document.querySelector('.publication-target-picker__virtual-spacer')?.style.height ===
          '30400px',
      );
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await last.waitFor();
      assert.equal(await last.evaluate((element) => element.getBoundingClientRect().height), 152);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS publication mobile editors ${browserType.name()} ${width}px ${colorScheme}`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
}
