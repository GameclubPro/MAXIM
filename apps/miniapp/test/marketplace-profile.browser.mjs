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
    ['iphone', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } }],
    ['android', { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }],
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
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => {
          if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
            errors.push(message.text());
        });
        await page.goto(`${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1`);
        const entry = page.getByRole('button', { name: 'Профиль на бирже', exact: true });
        await entry.click();
        const workspace = page.locator('.marketplace-profile');
        await workspace.getByLabel('Название', { exact: true }).waitFor();
        await workspace.getByLabel('Название', { exact: true }).fill('Мой несохранённый профиль');
        await page.locator('.marketplace-profile-overlay .settings-drilldown__close').click();
        await page
          .getByRole('button', { name: 'Продолжить настройку', exact: true })
          .waitFor({ timeout: 3000 });
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
        assert.equal(
          await workspace.getByLabel('Название', { exact: true }).inputValue(),
          'Мой несохранённый профиль',
        );
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
        assert.equal(
          await workspace.getByLabel('Название', { exact: true }).inputValue(),
          'Мой несохранённый профиль',
        );
        assert.match(await workspace.textContent(), /Новый профиль · не сохранён/u);
        await applyNativeVisualMode(page, {
          safeTop: deviceName === 'iphone' ? 20 : 24,
          safeBottom: 0,
        });
        const create = workspace.getByRole('button', { name: 'Создать черновик', exact: true });
        assert.equal(await create.isDisabled(), true);
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        await workspace.getByRole('checkbox', { name: /Разрешаю передавать статистику/u }).check();
        await create.click();
        await workspace
          .getByRole('button', { name: 'Опубликовать на бирже', exact: true })
          .waitFor();
        assert.equal(
          await workspace.getByLabel('Название', { exact: true }).count(),
          0,
          'Saved profile opens a summary',
        );
        assert.match(
          await workspace.textContent(),
          /Для рекламы и взаимопиара подключите бота «Связки»/u,
        );
        const toggle = workspace.getByRole('checkbox', { name: /Кнопка «Профиль на бирже»/u });
        assert.equal(await toggle.isChecked(), false);
        assert.equal(await toggle.isDisabled(), true);
        await workspace.getByRole('button', { name: 'Опубликовать на бирже', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть профиль', exact: true }).waitFor();
        const connect = workspace.getByRole('button', {
          name: 'Подключить бота «Связки»',
          exact: true,
        });
        await connect.click();
        assert.equal(
          await page.evaluate(
            (expected) =>
              window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) =>
                JSON.stringify(event).includes(expected),
              ),
            `connect_${kind}_-100`,
          ),
          true,
        );
        assert.match(
          await workspace.textContent(),
          new RegExp(
            profile === 'publisher' ? 'публикациях Публика' : 'публикациях ботов Майора',
            'u',
          ),
        );
        await toggle.click();
        await page.waitForFunction(
          () => document.querySelector('.marketplace-profile__switch input')?.checked === true,
        );
        await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
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
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        assert.equal(await toggle.isChecked(), false);
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть профиль', exact: true }).waitFor();
        await workspace
          .getByRole('button', { name: 'Отключить обмен статистикой', exact: true })
          .click();
        await workspace.getByText('Обмен статистикой отключён.', { exact: true }).waitFor();
        assert.match(
          await workspace.textContent(),
          /Новые замеры и кнопка в публикациях не добавляются/u,
        );
        assert.equal(await workspace.getByText('Профиль опубликован', { exact: true }).count(), 0);
        const resume = workspace.getByRole('button', {
          name: 'Возобновить обмен статистикой',
          exact: true,
        });
        await resume.waitFor();
        assert.equal(await resume.isDisabled(), true, 'Fresh access must not restore consent');
        const hide = workspace.getByRole('button', { name: 'Скрыть профиль', exact: true });
        await hide.click();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        assert.equal(await resume.isDisabled(), true, 'Hiding must not restore consent');
        await workspace.getByRole('checkbox', { name: /Разрешаю передавать статистику/u }).check();
        await resume.click();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        assert.equal(await toggle.isChecked(), false, 'Reconnect must not re-enable CTA');
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).click();
        const save = workspace.getByRole('button', { name: 'Сохранить изменения', exact: true });
        assert.equal(await save.isDisabled(), true, 'Unchanged profile has no save action');
        await workspace.getByLabel('Описание', { exact: true }).fill('Моё новое описание');
        await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
        assert.equal(
          await workspace.getByLabel('Описание', { exact: true }).inputValue(),
          'Моё новое описание',
        );
        await save.click();
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).waitFor();
        await page.locator('.marketplace-profile-overlay .settings-drilldown__close').click();
        assert.match(await entry.textContent(), /Профиль скрыт/u);
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
