import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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

const base = 'http://127.0.0.1:3019/app/';
const output = await mkdtemp('/tmp/maxim-publication-time-');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
let activePage;
async function assertLayout(page) {
  const metrics = await page.locator('.time-field-sheet__panel').evaluate((panel) => {
    const rect = panel.getBoundingClientRect();
    const button = panel.querySelector('.time-field-sheet__button--apply');
    const action = button.getBoundingClientRect();
    return {
      inside:
        rect.left >= 0 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= 0 &&
        rect.bottom <= visualViewport.height + visualViewport.offsetTop + 1,
      overflow: panel.scrollWidth - panel.clientWidth,
      reachable: button.contains(
        document.elementFromPoint(action.left + action.width / 2, action.top + action.height / 2),
      ),
    };
  });
  assert.ok(metrics.inside && metrics.overflow <= 1 && metrics.reachable, JSON.stringify(metrics));
}
try {
  for (const profile of [
    {
      name: 'iphone-se',
      device: devices['iPhone SE'],
      platform: 'ios',
      safeTop: 20,
      safeBottom: 0,
    },
    {
      name: 'android',
      device: devices['Pixel 7'],
      platform: 'android',
      safeTop: 24,
      safeBottom: 0,
    },
    {
      name: 'desktop',
      device: { viewport: { width: 1280, height: 900 } },
      platform: 'web',
      safeTop: 0,
      safeBottom: 0,
    },
  ])
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
        colorScheme,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ body: '' }),
      );
      await installMaxBridgeShimInitScript(context, profile, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      activePage = page;
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}publications?preview=1&profile=publisher&compose=1`);
      await page.getByRole('group', { name: 'Время публикации', exact: true }).waitFor();
      await applyNativeVisualMode(page, profile);
      await page.getByRole('button', { name: 'Один раз', exact: true }).click();
      await page.locator('.publication-once-fields .time-field__button').click();
      const dialog = page.locator('.time-field-sheet__panel');
      const hour = dialog.getByRole('textbox', { name: 'Часы', exact: true });
      const minute = dialog.getByRole('textbox', { name: 'Минуты', exact: true });
      const apply = dialog.getByRole('button', { name: 'Применить', exact: true });
      await hour.focus();
      await minute.focus();
      await apply.click();
      await page.getByRole('button', { name: 'Время: Не задано', exact: true }).click();
      await hour.fill('09');
      await minute.fill('17');
      await assertLayout(page);
      await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-exact.png` });
      await minute.fill('60');
      assert.equal(await apply.isDisabled(), true);
      await dialog.getByRole('button', { name: 'Минуты: 45', exact: true }).click();
      assert.equal(await minute.inputValue(), '45');
      await minute.fill('17');
      if (profile.name !== 'desktop') {
        await page.evaluate(() => {
          Object.defineProperty(visualViewport, 'height', { configurable: true, value: 300 });
          visualViewport.dispatchEvent(new Event('resize'));
        });
        await page.waitForFunction(
          () => document.querySelector('.time-field-sheet').getBoundingClientRect().height <= 301,
        );
        await assertLayout(page);
        await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-keyboard.png` });
        await page.evaluate(() => {
          delete visualViewport.height;
          visualViewport.dispatchEvent(new Event('resize'));
        });
      }
      await apply.click();
      await page.getByRole('button', { name: 'Время: 09:17', exact: true }).click();
      assert.equal(await minute.inputValue(), '17');
      await minute.fill('59');
      await dialog.getByRole('button', { name: 'Увеличить минуты', exact: true }).click();
      assert.equal(await minute.inputValue(), '00');
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.getByRole('button', { name: 'Время: 09:17', exact: true }).waitFor();

      await page
        .getByRole('group', { name: 'Время публикации', exact: true })
        .getByRole('button', { name: 'Расписание', exact: true })
        .click();
      await page
        .getByRole('group', { name: 'Тип расписания', exact: true })
        .getByRole('button', { name: 'Повтор', exact: true })
        .click();
      await page.getByRole('button', { name: 'Добавить время', exact: true }).click();
      await page.locator('.publication-recurrence__times .time-field__button').first().click();
      await hour.fill('23');
      await minute.fill('59');
      assert.equal(await minute.inputValue(), '59');
      await apply.click();
      await page.getByRole('button', { name: 'Время 1: 23:59', exact: true }).waitFor();

      await page
        .getByRole('group', { name: 'Тип расписания', exact: true })
        .getByRole('button', { name: 'Даты', exact: true })
        .click();
      await page.getByRole('button', { name: /Выбрать даты/u }).click();
      await page
        .locator('.broadcast-planner__day:not(:disabled):not(.is-today):not(.is-busy)')
        .first()
        .click();
      await page
        .locator('.broadcast-planner__dock')
        .getByRole('button', { name: 'Время', exact: true })
        .click();
      await page.locator('.broadcast-planner__custom-time .time-field__button').click();
      await hour.fill('09');
      await minute.fill('17');
      await apply.click();
      const remove = page.getByRole('button', { name: 'Удалить время 09:17', exact: true });
      await remove.waitFor();
      await page.screenshot({ path: `${output}/${profile.name}-${colorScheme}-calendar.png` });
      await remove.click();
      assert.equal(await remove.count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(`Minute-precision publication UI passed. Screenshots: ${output}`);
} catch (error) {
  if (activePage && !activePage.isClosed())
    await activePage.screenshot({ path: `${output}/failure.png` });
  console.error(`Failure screenshot: ${output}/failure.png`);
  throw error;
} finally {
  await browser.close();
  await stopChildProcess(server);
}
