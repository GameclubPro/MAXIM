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

const baseUrl =
  process.env.MINIAPP_MARKETPLACE_TEST_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const server = await ensureMiniappDevServer(baseUrl, {
  reuseServer: process.env.MINIAPP_MARKETPLACE_TEST_REUSE_SERVER === '1',
});
const output = await mkdtemp(path.join(tmpdir(), 'maxim-marketplace-profile-'));
let browser;
async function assertInternalExchangeHidden(workspace) {
  assert.doesNotMatch(
    await workspace.innerText(),
    /обмен статистик|переда(?:вать|чу|ча|чи).*статистик|согласи[^.]*статистик|MAXIM/iu,
  );
  assert.equal(await workspace.getByRole('checkbox', { name: /статистик/iu }).count(), 0);
  assert.equal(await workspace.getByRole('button', { name: /обмен|статистик/iu }).count(), 0);
  const hints = await workspace
    .locator('[aria-label], [title]')
    .evaluateAll((elements) =>
      elements.flatMap((element) => [
        element.getAttribute('aria-label') ?? '',
        element.getAttribute('title') ?? '',
      ]),
    );
  assert.doesNotMatch(hints.join('\n'), /обмен статистик|MAXIM/iu);
}
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
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1&marketplaceReady=delayed`,
        );
        const entry = page.getByRole('button', { name: 'Рекламная биржа', exact: true });
        await entry.waitFor();
        assert.equal(await entry.getAttribute('data-settings-navigation-entry'), 'true');
        assert.equal((await entry.textContent()).trim(), 'Рекламная биржа');
        assert.equal(
          await entry
            .locator('small, .settings-section__summary, .settings-section__state')
            .count(),
          0,
        );
        await entry.click();
        assert.equal(await entry.getAttribute('aria-expanded'), 'true');
        const workspace = page.locator('.marketplace-entry');
        await workspace.getByLabel('Название', { exact: true }).waitFor();
        await assertInternalExchangeHidden(workspace);
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
        assert.equal(
          await create.isDisabled(),
          true,
          'A complete form cannot grant its own access',
        );
        await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('.marketplace-profile__form button[type="submit"]')?.disabled ===
            false,
        );
        await assertInternalExchangeHidden(workspace);
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
          /Для рекламы и взаимопиара подключите бота «Биржика»/u,
        );
        const toggle = workspace.getByRole('checkbox', {
          name:
            profile === 'publisher'
              ? 'В публикациях'
              : kind === 'channel'
                ? 'В новых постах канала'
                : 'В уведомлениях модерации',
          exact: true,
        });
        assert.equal(await toggle.isChecked(), false);
        assert.equal(await toggle.isDisabled(), true);
        await assertInternalExchangeHidden(workspace);
        await workspace.getByRole('button', { name: 'Опубликовать на бирже', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть профиль', exact: true }).waitFor();
        const connect = workspace.getByRole('button', {
          name: 'Подключить бота «Биржика»',
          exact: true,
        });
        await connect.click();
        await page.waitForFunction(
          (expected) =>
            window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) =>
              JSON.stringify(event).includes(expected),
            ),
          `connect_${kind}_-100`,
        );
        assert.match(
          await workspace.textContent(),
          new RegExp(
            profile === 'publisher'
              ? 'В публикациях'
              : kind === 'channel'
                ? 'В новых постах канала'
                : 'В уведомлениях модерации',
            'u',
          ),
        );
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].some(
            (input) => input.checked,
          ),
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
        await assertInternalExchangeHidden(workspace);
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).click();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        assert.equal(
          await toggle.isChecked(),
          true,
          'Pausing suppresses the button without removing the explicit policy',
        );
        await workspace.getByText('Профиль недоступен посетителям.', { exact: true }).waitFor();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).click();
        await workspace.getByRole('button', { name: 'Открыть профиль', exact: true }).waitFor();
        const hide = workspace.getByRole('button', { name: 'Скрыть профиль', exact: true });
        await hide.click();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        assert.equal(
          await toggle.isChecked(),
          true,
          'Refreshing preserves the explicit policy while the paused profile suppresses its effect',
        );
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
        assert.equal((await entry.textContent()).trim(), 'Рекламная биржа');
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1&marketplaceReady=0`,
        );
        await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
        await workspace.getByLabel('Название', { exact: true }).waitFor();
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
        await workspace.getByText('Профиль пока недоступен.', { exact: true }).waitFor();
        assert.equal(
          await create.isDisabled(),
          true,
          'A refresh cannot override unavailable access',
        );
        await assertInternalExchangeHidden(workspace);
        await page.screenshot({
          path: path.join(
            output,
            `${deviceName}-${colorScheme}-${profile}-${kind}-unavailable.png`,
          ),
          fullPage: false,
        });
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplaceOwner=0&focus=birzhik`,
        );
        await workspace.getByRole('button', { name: 'Открыть профиль', exact: true }).waitFor();
        assert.equal(
          await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).count(),
          0,
        );
        assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
        const expectedCount = profile === 'moderation' && kind === 'chat' ? 2 : 1;
        assert.equal(await workspace.getByRole('checkbox').count(), expectedCount);
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].some(
            (input) => input.checked,
          ),
        );
        assert.equal(await toggle.isChecked(), true);
        if (expectedCount === 2)
          assert.equal(
            await workspace
              .getByRole('checkbox', { name: 'В приветствиях', exact: true })
              .isChecked(),
            false,
          );
        await page.screenshot({
          path: path.join(
            output,
            `${deviceName}-${colorScheme}-${profile}-${kind}-second-admin.png`,
          ),
          fullPage: false,
        });
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await workspace.waitFor({ state: 'hidden' });
        assert.equal(new URL(page.url()).searchParams.has('focus'), false);
        if (profile === 'moderation' && kind === 'chat') {
          await page.goto(`${baseUrl}?preview=1`);
          await page.locator('#chat-search').waitFor();
          assert.equal(await page.locator('.chats-home__birzhik, .birzhik-handoff').count(), 0);
          assert.equal(
            await page.getByRole('link', { name: /^(Биржик|Рекламная биржа)$/u }).count(),
            0,
            'The platform list must not show a separate marketplace button',
          );
          await page.screenshot({
            path: path.join(output, `${deviceName}-${colorScheme}-home-without-marketplace.png`),
            fullPage: false,
          });
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }
  process.stdout.write(
    'Marketplace profile: 16 owner and 16 second-administrator browser scenarios passed (Major/Publisher, chat/channel, iPhone/Android, light/dark).\n',
  );
  process.stdout.write(`Screenshots: ${output}\n`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
