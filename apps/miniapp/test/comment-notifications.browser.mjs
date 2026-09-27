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

const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-notifications-'));
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3037/app/');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
try {
  for (const profile of [
    {
      name: 'small',
      device: { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } },
      platform: 'ios',
      safeTop: 20,
      safeBottom: 0,
    },
    { name: 'iphone', device: devices['iPhone 15'], platform: 'ios', safeTop: 59, safeBottom: 34 },
    {
      name: 'android',
      device: devices['Pixel 7'],
      platform: 'android',
      safeTop: 24,
      safeBottom: 24,
    },
  ]) {
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
      await context.route('**/src/main.tsx', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `import ${JSON.stringify(new URL('test/comment-dialog.fixture.tsx', base).href)};`,
        }),
      );
      await installMaxBridgeShimInitScript(context, profile, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}?profile=publisher`);
      await page.locator('.channel-dialog-message').first().waitFor();
      await applyNativeVisualMode(page, profile);
      await page.getByRole('button', { name: 'Настройки уведомлений', exact: true }).click();
      const sheet = page.getByRole('dialog', { name: 'Уведомления', exact: true });
      await sheet.waitFor();
      assert.equal(
        await sheet.getByRole('link', { name: 'Открыть Публик' }).getAttribute('href'),
        'https://max.ru/se14088825_bot',
      );
      const modes = sheet.getByRole('radiogroup', { name: 'Какие уведомления получать' });
      const scopes = sheet.getByRole('radiogroup', { name: 'Где получать уведомления' });
      await scopes.getByRole('radio', { name: 'Пост', exact: true }).click();
      await modes.getByRole('radio', { name: 'Все', exact: true }).click();
      await page.evaluate(() => window.commentTest.refresh());
      assert.equal(
        await modes.getByRole('radio', { name: 'Все', exact: true }).getAttribute('aria-checked'),
        'true',
        'polling must preserve the draft',
      );
      await page.evaluate(() => window.commentTest.failNotificationSave());
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await page.getByText('Не удалось сохранить уведомления', { exact: true }).waitFor();
      assert.equal(
        await modes.getByRole('radio', { name: 'Все', exact: true }).getAttribute('aria-checked'),
        'true',
      );
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await sheet.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Закрыть уведомление', exact: true }).click();
      await page.getByRole('button', { name: 'Настройки уведомлений', exact: true }).click();
      assert.equal(
        await modes.getByRole('radio', { name: 'Все', exact: true }).getAttribute('aria-checked'),
        'true',
      );
      await scopes.getByRole('radio', { name: 'Канал', exact: true }).click();
      assert.equal(
        await modes.getByRole('radio', { name: 'Выкл', exact: true }).getAttribute('aria-checked'),
        'true',
        'scope selection must load its own saved mode',
      );
      await modes.getByRole('radio', { name: 'Выкл', exact: true }).focus();
      await page.keyboard.press('Home');
      assert.equal(
        await modes
          .getByRole('radio', { name: 'Ответы', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      const dimensions = await sheet.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          viewport: visualViewport.height,
          overflow: document.documentElement.scrollWidth - innerWidth,
          buttonsFit: [...element.querySelectorAll('button')].every(
            (button) => button.scrollWidth <= button.clientWidth + 1,
          ),
        };
      });
      assert.ok(
        dimensions.top >= 0 &&
          dimensions.bottom <= dimensions.viewport + 1 &&
          dimensions.overflow <= 1 &&
          dimensions.buttonsFit,
        JSON.stringify(dimensions),
      );
      await page.screenshot({ path: path.join(output, `${profile.name}-${colorScheme}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(`Publisher notification browser checks passed: ${output}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
