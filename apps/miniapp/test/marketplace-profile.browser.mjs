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

const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(baseUrl);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-marketplace-profile-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [deviceName, device] of [
    ['iphone', devices['iPhone SE']],
    ['android', devices['Pixel 7']],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const [profile, kind, route] of [
        ['moderation', 'chat', 'chat/preview-chat/settings'],
        ['moderation', 'channel', 'channel/preview-channel/settings'],
        ['publisher', 'chat', 'publisher/chat/preview-chat'],
        ['publisher', 'channel', 'publisher/channel/preview-channel'],
      ]) {
        const context = await browser.newContext({ ...device, colorScheme });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        await installNativeVisualModeInitScript(context);
        await context.route('**/*', (request) =>
          new URL(request.request().url()).origin === new URL(baseUrl).origin
            ? request.continue()
            : request.abort(),
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1`);
        const entry = page.getByRole('button', { name: 'Профиль на бирже', exact: true });
        await entry.click();
        const workspace = page.locator('.marketplace-profile');
        await workspace.getByLabel('Название', { exact: true }).waitFor();
        await applyNativeVisualMode(page, {
          safeTop: deviceName === 'iphone' ? 20 : 24,
          safeBottom: 0,
        });
        const create = workspace.getByRole('button', { name: 'Создать профиль', exact: true });
        assert.equal(await create.isDisabled(), true);
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        await workspace.getByRole('checkbox', { name: /Разрешаю передавать статистику/u }).check();
        await create.click();
        await workspace
          .getByRole('button', { name: 'Опубликовать профиль', exact: true })
          .waitFor();
        assert.match(await workspace.textContent(), /Для размещений подключите бота биржи/u);
        const toggle = workspace.getByRole('checkbox', { name: /Добавлять кнопку профиля/u });
        assert.equal(await toggle.isChecked(), false);
        assert.equal(await toggle.isDisabled(), true);
        await workspace.getByRole('button', { name: 'Опубликовать профиль', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть на бирже', exact: true }).waitFor();
        await toggle.click();
        await page.waitForFunction(
          () => document.querySelector('.marketplace-profile__switch input')?.checked === true,
        );
        await workspace.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        assert.equal(await toggle.isChecked(), true);
        await toggle.scrollIntoViewIfNeeded();
        assert.equal(
          await page
            .locator('.marketplace-profile-overlay .settings-drilldown__panel')
            .evaluate((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.top >= 0 &&
                rect.bottom <= innerHeight + 1 &&
                rect.left >= 0 &&
                rect.right <= innerWidth + 1
              );
            }),
          true,
          'Profile panel must fit the real mobile viewport',
        );
        assert.equal(
          await workspace.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(output, `${deviceName}-${colorScheme}-${profile}-${kind}.png`),
          fullPage: false,
        });
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).click();
        await workspace
          .getByRole('button', { name: 'Опубликовать профиль', exact: true })
          .waitFor();
        assert.equal(await toggle.isChecked(), false);
        await workspace.getByRole('button', { name: 'Опубликовать профиль', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть на бирже', exact: true }).waitFor();
        await workspace
          .getByRole('button', { name: 'Отключить обмен статистикой', exact: true })
          .click();
        await workspace.getByText('Обмен статистикой отключён', { exact: true }).waitFor();
        assert.match(
          await workspace.textContent(),
          /Обмен статистикой и кнопка профиля отключены/u,
        );
        assert.equal(await workspace.getByText('Профиль опубликован', { exact: true }).count(), 0);
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }
  process.stdout.write(
    'Marketplace profile: 16 browser scenarios passed (Major/Publisher, chat/channel, iPhone/Android, light/dark).\n',
  );
  process.stdout.write(`Screenshots: ${output}\n`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
