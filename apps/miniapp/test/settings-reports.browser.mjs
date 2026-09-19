import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-reports-ui-'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_TEST_REUSE_SERVER === '1',
});
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, theme, platform] of [
    ['iphone-se-light', 320, 568, 'light', 'ios'],
    ['iphone-dark', 390, 844, 'dark', 'ios'],
    ['android-light', 412, 915, 'light', 'android'],
    ['desktop-dark', 1280, 900, 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '/* local bridge */' }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
    await page.getByRole('button', { name: 'Жалобы', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Жалобы', exact: true }).click();
    const panel = page
      .locator('.settings-drilldown__panel')
      .filter({ has: page.locator('.reports-settings') });
    await panel.getByRole('switch', { name: 'Жалобы участников', exact: true }).check();
    await panel.getByRole('spinbutton', { name: 'Порог жалоб' }).fill('6');
    await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).fill('спам, /alert');
    await panel.getByRole('combobox', { name: 'Удаление' }).selectOption('HISTORY_24H');
    await panel.getByRole('switch', { name: 'Мут', exact: true }).check();
    await panel.getByRole('spinbutton', { name: 'Длительность мута, ч' }).fill('24');
    await page.screenshot({ path: join(screenshots, `${name}-settings.png`) });
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('.settings-drilldown__footer-actions [aria-busy="true"]'),
    );
    if (await panel.isVisible())
      await panel.getByRole('button', { name: 'Закрыть панель' }).click();
    await page.getByRole('button', { name: 'Жалобы', exact: true }).click();
    assert.equal(await panel.getByRole('spinbutton', { name: 'Порог жалоб' }).inputValue(), '6');
    assert.equal(
      await panel.getByRole('textbox', { name: 'Дополнительные команды, до 5' }).inputValue(),
      'спам, /alert',
    );
    assert.equal(
      await panel.getByRole('spinbutton', { name: 'Длительность мута, ч' }).inputValue(),
      '24',
    );
    await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
    await panel.getByText('Сбор голосов', { exact: true }).click();
    await panel
      .getByRole('link', { name: 'Открыть профиль: Мария Волкова', exact: true })
      .waitFor();
    await panel
      .getByRole('link', { name: 'Открыть профиль: Александр Соколов', exact: true })
      .waitFor();
    await panel.getByRole('button', { name: 'Отклонить жалобы', exact: true }).click();
    await panel.getByText('Отклонено', { exact: true }).waitFor();
    await panel.getByText('Частично', { exact: true }).click();
    await panel.getByText('Не все сообщения удалось удалить.', { exact: true }).waitFor();
    await panel.getByRole('heading', { name: 'Участники', exact: true }).waitFor();
    for (const name of ['Андрей Николаев', 'Мария Волкова', 'Дмитрий Орлов', 'Елена Миронова']) {
      const link = panel.getByRole('link', { name: `Открыть профиль: ${name}`, exact: true });
      await link.waitFor();
      assert.match(await link.getAttribute('href'), /^https:\/\/max\.ru\//u);
    }
    assert.doesNotMatch(
      await panel.locator('.reports-journal__detail').innerText(),
      /10020030[0-9]/u,
    );
    await panel.getByText('Уже отсутствуют', { exact: true }).waitFor();
    await page.locator('.toast').waitFor({ state: 'hidden', timeout: 10_000 });
    await page.screenshot({ path: join(screenshots, `${name}-journal.png`) });
    await panel.getByRole('link', { name: 'Открыть профиль: Мария Волкова', exact: true }).click();
    await page.waitForFunction(() =>
      window.__MAXIM_VISUAL_BRIDGE_EVENTS__?.some((event) => event.type === 'openMaxLink'),
    );
    assert.equal(await panel.getByText('Не удалось открыть профиль.', { exact: true }).count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(
      await panel
        .locator('button, label, h3')
        .evaluateAll((nodes) =>
          nodes
            .filter(
              (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2,
            )
            .map((node) => node.textContent),
        ),
      [],
    );
    assert.deepEqual(errors, []);
    await page.goto(
      new URL('chat/preview-chat/settings?preview=1&reportsAvailability=paused', base).href,
    );
    await page.getByRole('button', { name: 'Жалобы', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Жалобы', exact: true }).click();
    await panel.getByText('Приём жалоб приостановлен оператором.', { exact: true }).waitFor();
    assert.equal(
      await panel.getByRole('switch', { name: 'Жалобы участников', exact: true }).isDisabled(),
      true,
    );
    await page.screenshot({ path: join(screenshots, `${name}-paused.png`) });
    await panel.getByRole('tab', { name: 'Журнал', exact: true }).click();
    await panel.getByText('Сбор голосов', { exact: true }).waitFor();
    await page.goto(
      new URL(
        'chat/preview-chat/settings?preview=1&reportsAvailability=paused&reportsOptIn=1',
        base,
      ).href,
    );
    await page.getByRole('button', { name: 'Жалобы', exact: true }).waitFor();
    await applyNativeVisualMode(page, {
      safeTop: platform === 'ios' ? 47 : 24,
      safeBottom: platform === 'ios' ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Жалобы', exact: true }).click();
    const pausedSwitch = panel.getByRole('switch', { name: 'Жалобы участников', exact: true });
    assert.equal(await pausedSwitch.isChecked(), true);
    assert.equal(await pausedSwitch.isDisabled(), false);
    await pausedSwitch.uncheck();
    assert.equal(await pausedSwitch.isDisabled(), true);
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await context.close();
    console.log(`PASS ${name}: report controls, save, journal and layout`);
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
