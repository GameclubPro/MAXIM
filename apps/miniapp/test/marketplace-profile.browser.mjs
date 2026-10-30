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
import { setPhoneKeyboard, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';

const baseUrl =
  process.env.MINIAPP_MARKETPLACE_TEST_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const server = await ensureMiniappDevServer(baseUrl, {
  reuseServer: process.env.MINIAPP_MARKETPLACE_TEST_REUSE_SERVER === '1',
});
const output = await mkdtemp(path.join(tmpdir(), 'maxim-marketplace-profile-'));
console.log(`Marketplace browser screenshots: ${output}`);
let browser;
let activePage;
let scenarios = 0;
const scenarioFilter = process.env.MINIAPP_MARKETPLACE_TEST_FILTER
  ? new RegExp(process.env.MINIAPP_MARKETPLACE_TEST_FILTER)
  : null;
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
  await settleVisualFrame(page);
}
async function assertInternalExchangeHidden(workspace) {
  assert.doesNotMatch(
    await workspace.innerText(),
    /обмен статистик|переда(?:вать|чу|ча|чи).*статистик|согласи[^.]*статистик|MAXIM/iu,
  );
  assert.equal(await workspace.getByRole('checkbox', { name: /статистик/iu }).count(), 0);
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
async function assertReachable(action, description) {
  await action.waitFor({ state: 'visible' });
  const bounds = await action.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewportTop = visualViewport?.offsetTop ?? 0;
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportTop,
      viewportBottom: viewportTop + (visualViewport?.height ?? innerHeight),
      viewportWidth: innerWidth,
      reachable: element.contains(
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
      ),
    };
  });
  assert.ok(
    bounds.top >= bounds.viewportTop - 1 &&
      bounds.bottom <= bounds.viewportBottom + 1 &&
      bounds.left >= -1 &&
      bounds.right <= bounds.viewportWidth + 1 &&
      bounds.reachable,
    `${description}: ${JSON.stringify(bounds)}`,
  );
}
async function assertLayout(panel, workspace) {
  assert.equal(
    await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (
        rect.top >= -1 &&
        rect.bottom <= innerHeight + 1 &&
        rect.left >= -1 &&
        rect.right <= innerWidth + 1
      );
    }),
    true,
    'Panel fits the actual phone viewport',
  );
  assert.equal(
    await workspace.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    'Workspace has no horizontal overflow',
  );
}
const paths = [
  ['moderation', 'chat', 'chat/preview-chat/settings'],
  ['moderation', 'channel', 'channel/preview-channel/settings'],
  ['publisher', 'chat', 'publisher/chat/preview-chat'],
  ['publisher', 'channel', 'publisher/channel/preview-channel'],
];
try {
  browser = await chromium.launch({ headless: true });
  for (const [deviceName, device, selectedPaths] of [
    ['iphone', { ...devices['iPhone SE'], viewport: { width: 320, height: 568 } }, paths],
    ['android', { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, paths],
    ['android-360', { ...devices['Pixel 7'], viewport: { width: 360, height: 780 } }, [paths[0]]],
    [
      'iphone-430',
      { ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 932 } },
      [paths[3]],
    ],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const [profile, kind, route] of selectedPaths) {
        const key = `${deviceName}-${colorScheme}-${profile}-${kind}`;
        if (scenarioFilter && !scenarioFilter.test(key)) continue;
        console.log(`Marketplace journey: ${key}`);
        const context = await browser.newContext({ ...device, colorScheme });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme });
        await installNativeVisualModeInitScript(context);
        await context.route('**/*', (request) =>
          new URL(request.request().url()).origin === new URL(baseUrl).origin
            ? request.continue()
            : request.abort(),
        );
        const page = await context.newPage();
        activePage = page;
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
        const workspace = page.locator('.marketplace-entry');
        const panel = page.locator('.marketplace-profile-overlay .settings-drilldown__panel');
        const action = (name) => panel.getByRole('button', { name, exact: true });
        const openProfile = () => action('Настройки карточки').click();
        const openButtons = () => action('Кнопка в сообщениях').click();
        const exitPrompt = page.getByRole('dialog', { name: 'Выйти без сохранения?', exact: true });
        const externalPrompt = page.getByRole('dialog', {
          name: 'Есть несохранённые изменения',
          exact: true,
        });
        const title = workspace.getByRole('textbox', { name: 'Название', exact: true });
        const description = workspace.getByRole('textbox', { name: 'Описание', exact: true });
        const caption = workspace.getByRole('textbox', {
          name: 'Текст рекламной кнопки',
          exact: true,
        });
        const toggleName =
          profile === 'publisher'
            ? 'В публикациях Публика'
            : kind === 'channel'
              ? 'В новых постах канала'
              : 'В уведомлениях модерации';
        const toggle = workspace.getByRole('checkbox', { name: toggleName, exact: true });
        const screenshot = (name) =>
          page.screenshot({ path: path.join(output, `${key}-${name}.png`), fullPage: false });
        await action('Создать карточку площадки').waitFor();
        const entityTitle = await workspace
          .locator('.marketplace-profile__hero strong')
          .innerText();
        assert.equal(await title.count(), 0);
        assert.equal(await workspace.getByRole('checkbox').count(), 0);
        await assertInternalExchangeHidden(workspace);
        await action('Создать карточку площадки').click();
        assert.equal(await action('Назад').count(), 0, 'MAX uses native Back without a duplicate');
        await title.fill('Площадка с длинным названием для рекламных размещений');
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        assert.equal(await action('Создать черновик').isEnabled(), true);
        await action('Закрыть панель').click();
        await exitPrompt.waitFor();
        await exitPrompt.getByRole('button', { name: 'Остаться', exact: true }).click();
        assert.equal(
          await title.inputValue(),
          'Площадка с длинным названием для рекламных размещений',
        );
        await nativeBack(page);
        await action('Продолжить редактирование').waitFor();
        assert.equal(await exitPrompt.count(), 0, 'Internal Back never asks to discard a draft');
        await action('Продолжить редактирование').click();
        assert.equal(
          await title.inputValue(),
          'Площадка с длинным названием для рекламных размещений',
        );
        await nativeBack(page);
        await openButtons();
        await caption.waitFor();
        assert.equal(await toggle.isDisabled(), true, 'Draft cannot enable a public button');
        await caption.fill('Реклама на площадке');
        await workspace
          .locator('.marketplace-button-policy__sample')
          .getByText('Реклама на площадке', { exact: true })
          .waitFor();
        assert.equal(
          await action('Как выглядит кнопка').count(),
          0,
          'Preview requires no disclosure',
        );
        await nativeBack(page);
        await action('Продолжить редактирование').click();
        assert.equal(
          await caption.inputValue(),
          'Реклама на площадке',
          'Continue returns to the last changed editor',
        );
        await nativeBack(page);
        await action('Создать карточку площадки').click();
        assert.equal(
          await title.inputValue(),
          'Площадка с длинным названием для рекламных размещений',
          'Both editor drafts survive internal navigation',
        );
        await applyNativeVisualMode(page, {
          safeTop: deviceName.startsWith('iphone') ? 20 : 24,
          safeBottom: 0,
        });
        await returnToApp(page);
        await assertReachable(action('Создать черновик'), 'Create action is reachable');
        await screenshot('editor');
        await action('Создать черновик').click();
        await action('Опубликовать профиль').waitFor();
        assert.equal(await title.isVisible(), true, 'Saving stays in the direct editor');
        assert.equal(
          await action('Сохранить изменения').count(),
          0,
          'Unchanged profile has no save footer',
        );
        await action('Опубликовать профиль').click();
        await workspace
          .locator('[data-marketplace-action="primary"]')
          .getByText('Посмотреть профиль', { exact: true })
          .waitFor();
        const connect = action('Подключить бота');
        await connect.waitFor();
        assert.equal(await title.count(), 0, 'Successful publication returns to overview');
        assert.equal(await action('Посмотреть профиль').count(), 1);
        assert.doesNotMatch(await workspace.innerText(), /Дней со статистикой|Период:/u);
        await openButtons();
        assert.equal(
          await caption.inputValue(),
          'Реклама на площадке',
          'Publishing preserves the other editor draft',
        );
        await action('Сохранить текст').click();
        await action('Сохранить текст').waitFor({ state: 'hidden' });
        await workspace.getByText('Текст сохранён', { exact: true }).waitFor();
        await screenshot('caption-saved');
        await nativeBack(page);
        await screenshot('overview');
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
        await workspace.locator('.marketplace-workspace-identity strong').waitFor();
        assert.equal(
          await workspace.locator('.marketplace-workspace-identity strong').innerText(),
          entityTitle,
          'Button editor keeps the selected platform identity',
        );
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].some(
            (input) => input.checked,
          ),
        );
        await returnToApp(page);
        assert.equal(await toggle.isChecked(), true);
        if (kind === 'chat' && profile === 'moderation') {
          const group = workspace
            .locator('.marketplace-button-policy__group')
            .filter({ has: page.getByRole('checkbox', { name: toggleName, exact: true }) });
          const expand = group.getByRole('button', { name: 'По модулям', exact: true });
          await expand.click();
          const duplicates = group.getByRole('checkbox', { name: 'Антидубли', exact: true });
          assert.equal(await duplicates.isChecked(), true);
          await duplicates.click();
          await group.getByText('Включено 11 из 12', { exact: true }).waitFor();
          assert.equal(await toggle.getAttribute('aria-checked'), 'mixed');
          await group.getByRole('button', { name: 'Выключить все', exact: true }).click();
          await page.waitForFunction(
            () => !document.querySelector('.marketplace-button-policy__modules input:checked'),
          );
          await duplicates.click();
          await group.getByText('Включено 1 из 12', { exact: true }).waitFor();
          await toggle.click();
          await page.waitForFunction(
            () =>
              document.querySelectorAll('.marketplace-button-policy__modules input:checked')
                .length === 12,
          );
          await expand.click();
        }
        await assertLayout(panel, workspace);
        await screenshot('buttons');
        await caption.fill('Длинная подпись рекламной кнопки для проверки');
        await caption.focus();
        const keyboardMode = deviceName.startsWith('iphone') ? 'visual' : 'resize';
        await setPhoneKeyboard(page, { height: 260, mode: keyboardMode });
        await settleVisualFrame(page);
        await assertReachable(action('Сохранить текст'), 'Caption save stays above keyboard');
        await assertReachable(caption, 'Focused caption stays above keyboard and below header');
        await screenshot('keyboard');
        await caption.evaluate((element) => element.blur());
        await setPhoneKeyboard(page, { mode: keyboardMode, open: false });
        await settleVisualFrame(page);
        await action('Отмена').click();
        await nativeBack(page);
        await action('Кнопка в сообщениях').waitFor();
        await page.waitForFunction(
          () => document.activeElement?.textContent?.trim() === 'Кнопка в сообщениях',
        );
        await openProfile();
        await description.fill('Описание, которое ещё не сохранено');
        await nativeBack(page);
        await openButtons();
        await caption.fill('Несохранённая подпись');
        await nativeBack(page);
        const beforeExternal = await page.evaluate(
          () =>
            window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) =>
              ['openLink', 'openMaxLink'].includes(event.type),
            ).length,
        );
        await action('Посмотреть профиль').click();
        await externalPrompt.waitFor();
        assert.equal(
          await page.evaluate(
            () =>
              window.__MAXIM_VISUAL_BRIDGE_EVENTS__.filter((event) =>
                ['openLink', 'openMaxLink'].includes(event.type),
              ).length,
          ),
          beforeExternal,
          'No external navigation before resolving both drafts',
        );
        await externalPrompt
          .getByRole('button', { name: 'Продолжить редактирование', exact: true })
          .click();
        assert.equal(await caption.inputValue(), 'Несохранённая подпись');
        await nativeBack(page);
        await action('Посмотреть профиль').click();
        await externalPrompt.getByRole('button', { name: 'Остаться', exact: true }).click();
        await action('Посмотреть профиль').click();
        await externalPrompt
          .getByRole('button', { name: 'Отменить изменения и перейти', exact: true })
          .click();
        await page.waitForFunction(
          (expected) =>
            window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some((event) =>
              JSON.stringify(event).includes(expected),
            ),
          `listing_${kind}_`,
        );
        await returnToApp(page);
        assert.equal(await action('Продолжить редактирование').count(), 0);
        await openProfile();
        assert.notEqual(await description.inputValue(), 'Описание, которое ещё не сохранено');
        await description.fill('Сохраняемое описание площадки');
        await returnToApp(page);
        assert.equal(await description.inputValue(), 'Сохраняемое описание площадки');
        await action('Сохранить изменения').click();
        await action('Сохранить изменения').waitFor({ state: 'hidden' });
        assert.equal(
          await description.inputValue(),
          'Сохраняемое описание площадки',
          'Save keeps the editable result visible',
        );
        await screenshot('profile');
        await action('Скрыть профиль').click();
        await action('Опубликовать снова').waitFor();
        await nativeBack(page);
        await openButtons();
        assert.equal(await toggle.isChecked(), true, 'Hiding preserves saved consent');
        await workspace.getByText('Профиль недоступен посетителям.', { exact: true }).waitFor();
        assert.equal(await toggle.isDisabled(), false, 'Hidden profile still allows withdrawal');
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].every(
            (input) => !input.checked,
          ),
        );
        assert.equal(await toggle.isDisabled(), true, 'Hidden profile cannot re-enable consent');
        await nativeBack(page);
        await openProfile();
        await action('Опубликовать снова').click();
        await action('Посмотреть профиль').waitFor();
        await openProfile();
        await description.fill('Несохранённое описание перед выходом');
        await nativeBack(page);
        await openButtons();
        await caption.fill('Несохранённый текст перед выходом');
        await action('Закрыть панель').click();
        await exitPrompt.waitFor();
        await exitPrompt.getByRole('button', { name: 'Остаться', exact: true }).click();
        assert.equal(await caption.inputValue(), 'Несохранённый текст перед выходом');
        await nativeBack(page);
        await nativeBack(page);
        await exitPrompt.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
        await workspace.waitFor({ state: 'hidden' });
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        await entry.click();
        await openProfile();
        assert.equal(
          await description.inputValue(),
          'Сохраняемое описание площадки',
          'Explicit exit discards only unsaved profile changes',
        );
        await nativeBack(page);
        await openButtons();
        assert.equal(
          await caption.inputValue(),
          'Реклама на площадке',
          'Explicit exit discards unsaved caption',
        );
        if (deviceName.endsWith('360') || deviceName.endsWith('430')) {
          await caption.fill('Проверка увеличенного текста');
          await panel.evaluate((element) => {
            const nodes = [
              ...element.querySelectorAll(
                'button,input,textarea,label,span,strong,small,p,h3,summary,dt,dd',
              ),
            ];
            const sizes = nodes.map((node) => [node, parseFloat(getComputedStyle(node).fontSize)]);
            for (const [node, size] of sizes) node.style.fontSize = `${size * 2}px`;
          });
          await settleVisualFrame(page);
          await assertLayout(panel, workspace);
          await assertReachable(
            action('Сохранить текст'),
            'Save remains reachable at doubled actual text size',
          );
          assert.equal(
            await action('Сохранить текст').evaluate((element) => {
              const textNodes = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
              let node;
              while ((node = textNodes.nextNode())) {
                const start = node.textContent.indexOf('Сохранить');
                if (start === -1) continue;
                const word = document.createRange();
                word.setStart(node, start);
                word.setEnd(node, start + 'Сохранить'.length);
                const lineTops = [...word.getClientRects()].map((rect) => Math.round(rect.top));
                return new Set(lineTops).size === 1;
              }
              return false;
            }),
            true,
            'The save label keeps whole words at doubled actual text size',
          );
          await screenshot('large-text');
        }
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplacePilot=1&marketplaceReady=0`,
        );
        await entry.click();
        await action('Создать карточку площадки').click();
        await workspace.getByLabel('Тематика', { exact: true }).selectOption('Бизнес');
        await workspace.getByLabel('Регион', { exact: true }).selectOption('Россия');
        await returnToApp(page);
        await workspace.getByText('Профиль пока недоступен.', { exact: true }).waitFor();
        assert.equal(
          await action('Создать черновик').isDisabled(),
          true,
          'Refresh cannot override unavailable access',
        );
        await assertInternalExchangeHidden(workspace);
        await screenshot('unavailable');
        await page.goto(
          `${baseUrl}${route}?preview=1&profile=${profile}&marketplaceOwner=0&focus=birzhik`,
        );
        await action('Посмотреть профиль').waitFor();
        assert.equal(await action('Настройки карточки').count(), 0);
        assert.equal(await action('Условия размещений').count(), 0);
        assert.equal(await title.count(), 0);
        await openButtons();
        await toggle.waitFor();
        assert.equal(
          await workspace.getByRole('checkbox').count(),
          profile === 'moderation' && kind === 'chat' ? 2 : 1,
        );
        await toggle.click();
        await page.waitForFunction(() =>
          [...document.querySelectorAll('.marketplace-profile__switch input')].some(
            (input) => input.checked,
          ),
        );
        assert.equal(await toggle.isChecked(), true);
        if (profile === 'moderation' && kind === 'chat')
          assert.equal(
            await workspace
              .getByRole('checkbox', { name: 'В приветствиях', exact: true })
              .isChecked(),
            false,
          );
        await screenshot('second-admin');
        await nativeBack(page);
        await action('Посмотреть профиль').waitFor();
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
          );
        }
        assert.deepEqual(errors, []);
        scenarios += 2;
        await context.close();
      }
    }
  }
  const browserContext = await browser.newContext({ viewport: { width: 390, height: 568 } });
  await browserContext.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(baseUrl).origin
      ? route.continue()
      : route.abort(),
  );
  const browserPage = await browserContext.newPage();
  activePage = browserPage;
  await browserPage.goto(
    `${baseUrl}chat/preview-chat/settings?preview=1&profile=moderation&marketplacePilot=1&marketplaceReady=ready&marketplacePublished=1`,
  );
  await browserPage.getByRole('button', { name: 'Рекламная биржа', exact: true }).click();
  const browserPanel = browserPage.locator(
    '.marketplace-profile-overlay .settings-drilldown__panel',
  );
  await browserPanel.getByRole('button', { name: 'Настройки карточки', exact: true }).click();
  await settleVisualFrame(browserPage);
  const browserScrollBody = browserPanel.locator('.settings-drilldown__body');
  const browserDescription = browserPanel.getByRole('textbox', { name: 'Описание', exact: true });
  const savedBrowserDescription = await browserDescription.inputValue();
  const draftBrowserDescription = 'Описание, которое продолжаем после внутреннего возврата';
  await browserDescription.fill(draftBrowserDescription);
  await browserDescription.focus();
  await settleVisualFrame(browserPage);
  const editorScrollTop = await browserScrollBody.evaluate((element) => {
    element.scrollTop = 90;
    return element.scrollTop;
  });
  assert.ok(editorScrollTop > 0, 'The browser editor has actual scrollable content');
  await browserPanel.getByRole('button', { name: 'Назад', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Настройки карточки', exact: true }).click();
  await settleVisualFrame(browserPage);
  assert.equal(await browserDescription.inputValue(), draftBrowserDescription);
  assert.ok(
    Math.abs(
      (await browserScrollBody.evaluate((element) => element.scrollTop)) - editorScrollTop,
    ) <= 1,
    'Returning to the same editor restores its prior scroll position',
  );
  assert.equal(
    await browserDescription.evaluate((element) => element === document.activeElement),
    true,
    'Reopening after clicking Back restores focus to the last edited profile field',
  );
  await browserPage.keyboard.press('Escape');
  await browserPanel.getByRole('button', { name: 'Настройки карточки', exact: true }).click();
  await settleVisualFrame(browserPage);
  assert.equal(await browserDescription.inputValue(), draftBrowserDescription);
  assert.equal(
    await browserDescription.evaluate((element) => element === document.activeElement),
    true,
    'Reopening after Escape restores focus to the remounted profile field',
  );
  assert.ok(
    Math.abs(
      (await browserScrollBody.evaluate((element) => element.scrollTop)) - editorScrollTop,
    ) <= 1,
    'Profile field focus restoration preserves the saved scroll position',
  );
  await browserDescription.fill(savedBrowserDescription);
  await browserPanel.getByRole('button', { name: 'Назад', exact: true }).click();
  await browserPanel.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
  await browserPage.keyboard.press('Escape');
  await browserPanel.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
  await browserPanel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
  await browserPanel.waitFor({ state: 'hidden' });
  await browserContext.close();
  console.log(
    `Marketplace profile: ${scenarios} owner/second-administrator scenarios and browser Back/Escape passed; screenshots: ${output}`,
  );
} catch (error) {
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    console.error((await activePage.locator('body').innerText()).slice(-7000));
  }
  throw error;
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
