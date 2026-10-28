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
console.log(`Marketplace browser screenshots: ${output}`);
let browser;
async function returnToApp(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function nativeBack(page) {
  await page.waitForFunction(
    () =>
      document.querySelector('.marketplace-profile-overlay .settings-drilldown__close')
        ?.disabled === false,
  );
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
}
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
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1&marketplaceReady=ready`,
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
        const panel = page.locator('.marketplace-profile-overlay .settings-drilldown__panel');
        const openProfile = () =>
          workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).click();
        const openButtons = () =>
          workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
        const toggleName =
          profile === 'publisher'
            ? 'В публикациях Публика'
            : kind === 'channel'
              ? 'В новых постах канала'
              : 'В уведомлениях модерации';
        const toggle = workspace.getByRole('checkbox', { name: toggleName, exact: true });
        await workspace.getByRole('button', { name: 'Создать профиль', exact: true }).waitFor();
        assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
        assert.equal(await workspace.getByRole('checkbox').count(), 0);
        assert.doesNotMatch(await workspace.innerText(), /Дней со статистикой|Период:/u);
        await assertInternalExchangeHidden(workspace);
        await workspace.getByRole('button', { name: 'Создать профиль', exact: true }).click();
        await workspace.getByLabel('Название', { exact: true }).fill('Мой несохранённый профиль');
        const create = workspace.getByRole('button', { name: 'Создать черновик', exact: true });
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        assert.equal(await create.isEnabled(), true);
        // Unavailable-profile fencing is exercised with explicit server state in
        // marketplace-profile-states.browser.mjs, independent of request count.
        await panel.locator('.settings-drilldown__close').click();
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
        assert.equal(
          await workspace.getByLabel('Название', { exact: true }).inputValue(),
          'Мой несохранённый профиль',
        );
        await nativeBack(page);
        await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
        assert.equal(
          await workspace.getByLabel('Название', { exact: true }).inputValue(),
          'Мой несохранённый профиль',
          'Native Back preserves the draft when discard is cancelled',
        );
        await applyNativeVisualMode(page, {
          safeTop: deviceName === 'iphone' ? 20 : 24,
          safeBottom: 0,
        });
        await returnToApp(page);
        await page.waitForFunction(
          () =>
            document.querySelector('.marketplace-profile__form button[type="submit"]')?.disabled ===
            false,
        );
        await page.screenshot({
          path: path.join(output, `${deviceName}-${colorScheme}-${profile}-${kind}-editor.png`),
          fullPage: false,
        });
        await create.click();
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).waitFor();
        assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
        await nativeBack(page);
        await workspace
          .getByRole('button', { name: 'Опубликовать профиль', exact: true })
          .waitFor();
        await openButtons();
        assert.equal(await toggle.isChecked(), false);
        assert.equal(
          await toggle.isDisabled(),
          true,
          'Draft profile cannot enable a public button',
        );
        await nativeBack(page);
        await workspace.getByRole('button', { name: 'Опубликовать профиль', exact: true }).click();
        const connect = workspace.getByRole('button', { name: 'Подключить бота', exact: true });
        await connect.waitFor();
        await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
        assert.equal(await workspace.getByRole('checkbox').count(), 0);
        assert.doesNotMatch(await workspace.innerText(), /Дней со статистикой|Период:/u);
        assert.equal(
          await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).count(),
          0,
        );
        await page.screenshot({
          path: path.join(output, `${deviceName}-${colorScheme}-${profile}-${kind}-overview.png`),
          fullPage: false,
        });
        await connect.click();
        await page.waitForFunction(
          (expected) =>
            window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) =>
              JSON.stringify(event).includes(expected),
            ),
          `connect_${kind}_-100`,
        );
        await returnToApp(page);
        await openButtons();
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].some(
            (input) => input.checked,
          ),
        );
        await returnToApp(page);
        assert.equal(await toggle.isChecked(), true);
        const preview = workspace.getByRole('button', { name: 'Как выглядит кнопка', exact: true });
        assert.equal(await preview.getAttribute('aria-expanded'), 'false');
        await preview.click();
        assert.equal(await preview.getAttribute('aria-expanded'), 'true');
        await workspace.getByText('Профиль в Биржике', { exact: true }).waitFor();
        await toggle.scrollIntoViewIfNeeded();
        assert.equal(
          await panel.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.top >= 0 &&
              rect.bottom <= innerHeight + 1 &&
              rect.left >= 0 &&
              rect.right <= innerWidth + 1
            );
          }),
          true,
          'Nested settings fit the real mobile viewport',
        );
        assert.equal(
          await workspace.evaluate((element) => element.scrollWidth <= element.clientWidth),
          true,
        );
        await page.screenshot({
          path: path.join(output, `${deviceName}-${colorScheme}-${profile}-${kind}-buttons.png`),
          fullPage: false,
        });
        await assertInternalExchangeHidden(workspace);
        await nativeBack(page);
        await workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).waitFor();
        await page.waitForFunction(
          () => document.activeElement?.textContent?.trim() === 'Кнопка в сообщениях',
        );
        await openProfile();
        await page.screenshot({
          path: path.join(output, `${deviceName}-${colorScheme}-${profile}-${kind}-profile.png`),
          fullPage: false,
        });
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).click();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).waitFor();
        await nativeBack(page);
        await openButtons();
        assert.equal(await toggle.isChecked(), true, 'Hiding preserves the saved consent');
        await workspace.getByText('Профиль недоступен посетителям.', { exact: true }).waitFor();
        assert.equal(
          await toggle.isDisabled(),
          false,
          'Unavailable public profile still allows consent withdrawal',
        );
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].every(
            (input) => !input.checked,
          ),
        );
        assert.equal(
          await toggle.isDisabled(),
          true,
          'Hidden profile cannot re-enable the withdrawn consent',
        );
        await nativeBack(page);
        await openProfile();
        await workspace.getByRole('button', { name: 'Опубликовать снова', exact: true }).click();
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).waitFor();
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).click();
        const save = workspace.getByRole('button', { name: 'Сохранить изменения', exact: true });
        assert.equal(await save.isDisabled(), true, 'Unchanged profile has no save action');
        await workspace.getByLabel('Описание', { exact: true }).fill('Моё новое описание');
        await returnToApp(page);
        assert.equal(
          await workspace.getByLabel('Описание', { exact: true }).inputValue(),
          'Моё новое описание',
        );
        await save.click();
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).waitFor();
        await nativeBack(page);
        await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).waitFor();
        await nativeBack(page);
        await workspace.waitFor({ state: 'hidden' });
        assert.equal((await entry.textContent()).trim(), 'Рекламная биржа');
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1&marketplaceReady=0`,
        );
        await page.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
        await workspace.getByRole('button', { name: 'Создать профиль', exact: true }).click();
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        await returnToApp(page);
        await workspace.getByText('Профиль пока недоступен.', { exact: true }).waitFor();
        assert.equal(await create.isDisabled(), true, 'Refresh cannot override unavailable access');
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
        await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
        assert.equal(
          await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).count(),
          0,
        );
        assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
        assert.equal(await workspace.getByRole('checkbox').count(), 0);
        await openButtons();
        await toggle.waitFor();
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
        await nativeBack(page);
        await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
        await nativeBack(page);
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
