import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
const fixtures = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/shop-`),
  output = await mkdtemp('/tmp/maxim-shop-management-');
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/'),
  url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
let server;
let count = 0;
try {
  server = await ensureMiniappDevServer(base);
  for (const [engineName, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const width of process.env.SHOP_BROWSER_WIDTH
        ? [Number(process.env.SHOP_BROWSER_WIDTH)]
        : [320, 360, 375, 390, 430, 480])
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: Number(process.env.SHOP_BROWSER_HEIGHT ?? 780) },
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          try {
            await installMaxBridgeShimInitScript(context, {
              platform: engineName === 'webkit' ? 'ios' : 'android',
            });
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            const page = await context.newPage();
            page.setDefaultTimeout(12000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(`${url}?theme=${theme}`);
            await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
            const home = page.getByRole('dialog', { name: 'Интернет-витрина', exact: true });
            await home.getByRole('button', { name: 'Витрины', exact: true }).waitFor();
            assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
            assert.deepEqual(
              await home.locator('.karavan-shop__menu button').allTextContents(),
              ['Витрины', 'Заявки', 'Кнопки в чате', 'Настройки'],
              'the marketplace home has four clean navigation entries',
            );
            assert.equal(
              await home.locator('.karavan-shop__menu p,.karavan-shop__menu small').count(),
              0,
            );
            assert.equal(
              await home
                .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                .evaluate((el) => getComputedStyle(el).color),
              'rgb(255, 255, 255)',
              'primary action contrast',
            );
            await home
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .click();
            await page.waitForFunction(() => window.__shopOpened.length === 1);
            assert.ok(
              (await page.evaluate(() => window.__shopOpened[0])).includes('synthetic_buyer_bot'),
            );
            const shot = async (name, panel) => {
              await settleVisualFrame(page);
              assert.ok(
                await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
                `${name}: overflow`,
              );
              assert.ok(
                await panel.evaluate((node) =>
                  [...node.querySelectorAll('button,input,select,summary')]
                    .filter(
                      (control) =>
                        control.getBoundingClientRect().width > 0 &&
                        !['checkbox', 'radio', 'file'].includes(control.type),
                    )
                    .every((control) => control.getBoundingClientRect().height >= 43),
                ),
                `${name}: touch size`,
              );
              await page.screenshot({
                path: `${output}/${engineName}-${width}-${theme}-${name}.png`,
              });
            };
            const close = async (name) => {
              await page.getByRole('dialog', { name, exact: true }).waitFor();
              await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              if (['Оформление', 'Категории и правила', 'Подключённые чаты'].includes(name)) {
                await page.getByRole('dialog', { name: 'Настройки', exact: true }).waitFor();
                await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
              }
              await home.waitFor();
            };
            const openSetting = async (name) => {
              await home.getByRole('button', { name: 'Настройки', exact: true }).click();
              await page
                .getByRole('dialog', { name: 'Настройки', exact: true })
                .getByRole('button', { name, exact: true })
                .click();
            };
            await shot('home', home);
            await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            const responsePanel = page.getByRole('dialog', { name: 'Кнопки в чате', exact: true });
            const responseField = responsePanel.getByRole('textbox', {
              name: /^Текст ответа бота/,
            });
            assert.equal(await responseField.isVisible(), false);
            await page.evaluate(() => window.__setShopResponseError());
            await responseField.waitFor();
            await responseField.fill('Исправленный текст');
            assert.equal(
              await responsePanel
                .locator('.settings-storefront-editor__edit')
                .evaluate((node) => node.open),
              true,
              'correcting an error keeps the text editor open',
            );
            await responseField.fill('');
            await responsePanel.getByText('Изменить текст', { exact: true }).click();
            await close('Кнопки в чате');
            await home.getByRole('button', { name: 'Витрины', exact: true }).click();
            let panel = page.getByRole('dialog', { name: 'Витрины', exact: true });
            assert.equal(await page.getByRole('dialog').count(), 1, 'one storefront workspace');
            await panel
              .getByRole('tabpanel', { name: 'Витрины', exact: true })
              .getByText('Витрин пока нет')
              .waitFor();
            assert.equal(
              await panel
                .getByRole('tab', { name: 'Витрины', exact: true })
                .getAttribute('aria-selected'),
              'true',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests.filter((row) => row.body?.command?.operation === 'catalog')
                    .length,
              ),
              0,
              'opening storefronts does not fetch product offers',
            );
            await panel.getByRole('tab', { name: 'Витрины', exact: true }).focus();
            await page.keyboard.press('ArrowRight');
            await panel.getByRole('tabpanel', { name: 'Товары и услуги', exact: true }).waitFor();
            await panel.getByRole('button', { name: 'Закрепить', exact: true }).click();
            await panel.getByText('Закреплённые · 1', { exact: true }).waitFor();
            await panel.getByRole('button', { name: 'Скрыть', exact: true }).click();
            await panel.getByLabel('Причина', { exact: true }).fill('Не соответствует правилам');
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).click();
            await panel.getByRole('button', { name: 'Показать', exact: true }).waitFor();
            await shot('catalog', panel);
            await close('Витрины');
            await openSetting('Оформление');
            panel = page.getByRole('dialog', { name: 'Оформление', exact: true });
            await panel.getByLabel('Название', { exact: true }).waitFor();
            const swatches = await panel
              .locator('[data-accent]')
              .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).backgroundColor));
            assert.equal(
              new Set(swatches).size,
              5,
              'accent choices must show their distinct colors',
            );
            assert.ok(swatches.every((value) => value !== 'rgba(0, 0, 0, 0)'));
            await panel.getByLabel('Название', { exact: true }).fill('Новая главная соседей');
            await close('Оформление');
            await openSetting('Оформление');
            assert.equal(
              await panel.getByLabel('Название', { exact: true }).inputValue(),
              'Новая главная соседей',
              'internal Back preserves unsaved design',
            );
            await close('Оформление');
            await openSetting('Подключённые чаты');
            await page.getByRole('button', { name: 'Подключить чаты', exact: true }).click();
            await page.getByRole('radio', { name: 'Выбрать существующий', exact: true }).waitFor();
            await page.waitForFunction(() => {
              const fields = document.querySelector('.karavan-module__wizard-fields');
              return fields && !fields.disabled;
            });
            await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
            await page.getByRole('button', { name: 'Подключить чаты', exact: true }).waitFor();
            await close('Подключённые чаты');
            await openSetting('Оформление');
            assert.equal(
              await panel.getByLabel('Название', { exact: true }).inputValue(),
              'Новая главная соседей',
              'connecting chats preserves other editor drafts',
            );
            await panel.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Применить оформление', exact: true })
              .waitFor();
            assert.equal(await page.evaluate(() => window.__shopPublished.name), 'Магазин соседей');
            await panel
              .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
              .click();
            assert.equal(
              await page.evaluate(() => window.__shopOpened.at(-1)),
              'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
            );
            assert.equal(
              await page.evaluate(
                () => window.__shopRequests.filter((row) => row.path.endsWith('/handoffs')).length,
              ),
              0,
            );
            const publishedBeforeUpload = await page.evaluate(() => window.__shopPublished);
            await panel.getByLabel('Загрузить логотип').setInputFiles({
              name: 'logo.png',
              mimeType: 'image/png',
              buffer: Buffer.from(
                await page.evaluate(() => {
                  const canvas = document.createElement('canvas');
                  canvas.width = canvas.height = 16;
                  canvas.getContext('2d').fillRect(0, 0, 16, 16);
                  return canvas.toDataURL('image/png').split(',')[1];
                }),
                'base64',
              ),
            });
            await page.waitForFunction(() => typeof window.__finishShopImage === 'function');
            assert.equal(
              await panel
                .getByRole('button', { name: 'Применить оформление', exact: true })
                .isDisabled(),
              true,
              'applying the previous saved design must be blocked during image upload',
            );
            assert.deepEqual(
              await page.evaluate(() => window.__shopPublished),
              publishedBeforeUpload,
            );
            await page.evaluate(() => window.__finishShopImage());
            await panel.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Применить оформление', exact: true })
              .waitFor();
            await shot('appearance', panel);
            await panel.getByRole('button', { name: 'Применить оформление', exact: true }).click();
            await page.waitForFunction(
              () => window.__shopPublished.name === 'Новая главная соседей',
            );
            await close('Оформление');
            await openSetting('Категории и правила');
            panel = page.getByRole('dialog', { name: 'Категории и правила', exact: true });
            await panel.getByText('Услуги', { exact: true }).first().click();
            assert.equal(
              await panel
                .getByRole('checkbox', { name: 'Вся категория' })
                .first()
                .evaluate((el) => el.indeterminate),
              true,
            );
            await panel.getByRole('checkbox', { name: 'Ремонт', exact: true }).uncheck();
            await panel.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Применить категории и правила', exact: true })
              .waitFor();
            const preview = await page.evaluate(
              () =>
                window.__shopRequests
                  .filter((row) => row.body?.command?.operation === 'rules_preview')
                  .at(-1).body.command.input,
            );
            assert.ok(
              Date.parse(preview.effectiveAt) > Date.now() + 14 * 86400000,
              'hidden approved sellers retain notice period',
            );
            await panel
              .getByRole('button', { name: 'Применить категории и правила', exact: true })
              .click();
            await panel.getByRole('button', { name: 'Обновить данные', exact: true }).click();
            await panel.getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
            assert.equal(
              await panel
                .getByRole('button', { name: 'Применить категории и правила', exact: true })
                .count(),
              0,
            );
            assert.equal(
              await panel.getByRole('checkbox', { name: 'Ремонт', exact: true }).isChecked(),
              false,
            );
            await panel.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Применить категории и правила', exact: true })
              .waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests
                    .filter((row) => row.body?.command?.operation === 'rules_preview')
                    .at(-1).body.command.input.expectedPolicyRevision,
              ),
              2,
            );
            await panel
              .getByRole('button', { name: 'Применить категории и правила', exact: true })
              .click();
            await panel
              .getByRole('button', { name: 'Применить категории и правила', exact: true })
              .waitFor({ state: 'detached' });
            await shot('categories', panel);
            await close('Категории и правила');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
            assert.equal(
              await panel.getByRole('radio', { name: 'Все желающие', exact: true }).isChecked(),
              true,
            );
            assert.equal(
              await panel
                .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                .count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests.filter(
                    (row) => row.body?.command?.operation === 'invitations',
                  ).length,
              ),
              0,
              'open admission does not fetch invitation controls',
            );
            await panel.getByRole('radio', { name: 'По приглашению', exact: true }).check();
            assert.equal(
              await panel
                .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                .count(),
              0,
              'unsaved invitation policy cannot expose an invitation',
            );
            await close('Настройки');
            await home.getByRole('button', { name: 'Настройки', exact: true }).click();
            assert.equal(
              await panel.getByRole('radio', { name: 'По приглашению', exact: true }).isChecked(),
              true,
              'internal Back preserves admission draft',
            );
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await panel.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .waitFor();
            const admissionWrites = await page.evaluate(() =>
              window.__shopRequests.filter((row) => row.body?.command?.operation === 'settings'),
            );
            assert.equal(admissionWrites.length, 2);
            assert.deepEqual(
              admissionWrites[1].body,
              admissionWrites[0].body,
              'admission retry preserves the immutable command',
            );
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .click();
            await panel.getByRole('button', { name: 'Скопировано', exact: true }).waitFor();
            assert.deepEqual(await page.evaluate(() => window.__shopClipboard), [
              'https://max.ru/synthetic_seller_bot?startapp=invite_synthetic',
            ]);
            await panel.getByRole('button', { name: 'Скопировано', exact: true }).click();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests.filter(
                    (row) => row.body?.command?.operation === 'invitation_create',
                  ).length,
              ),
              1,
              'copying the same invitation never creates another invitation',
            );
            await panel.getByRole('button', { name: 'Отозвать приглашение', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .waitFor();
            await page.evaluate(() => {
              window.__dropShopInvitationUrl = true;
            });
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .click();
            await panel.getByRole('alert').filter({ hasText: 'Ссылка не сохранилась.' }).waitFor();
            await panel.getByRole('button', { name: 'Отозвать приглашение', exact: true }).click();
            await panel
              .getByRole('alert')
              .filter({ hasText: 'Ссылка не сохранилась.' })
              .waitFor({ state: 'detached' });
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .click();
            await panel.getByRole('button', { name: 'Скопировано', exact: true }).waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests.filter(
                    (row) => row.body?.command?.operation === 'invitation_create',
                  ).length,
              ),
              3,
              'revoking a lost invitation allows a new invitation',
            );
            await panel.getByRole('radio', { name: 'Все желающие', exact: true }).check();
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Скопировано', exact: true })
              .waitFor({ state: 'detached' });
            await panel
              .getByRole('button', { name: 'Сохранить', exact: true })
              .waitFor({ state: 'detached' });
            await panel
              .getByRole('button', { name: 'Скопировать приглашение', exact: true })
              .waitFor({ state: 'detached' });
            assert.equal(
              await panel
                .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                .count(),
              0,
            );
            await shot('admission', panel);
            await close('Настройки');
            await home.getByRole('button', { name: 'Заявки', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Заявки', exact: true });
            const applications = panel.locator('[data-storefront-screen="applications"]');
            await applications
              .locator('summary')
              .filter({ hasText: /^Товары и услуги$/u })
              .click();
            await applications
              .getByText('Ремонт стиральной машины с выездом на дом', { exact: true })
              .waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests.filter((row) => row.body?.command?.operation === 'decide')
                    .length,
              ),
              0,
              'reviewing application content does not approve it',
            );
            await panel.getByRole('button', { name: 'Одобрить', exact: true }).click();
            await panel.getByText('Новых заявок нет').waitFor();
            await close('Заявки');
            await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Кнопки в чате', exact: true });
            assert.equal(
              await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).isVisible(),
              false,
            );
            await panel.getByText('Изменить текст', { exact: true }).click();
            await panel
              .getByRole('textbox', { name: /^Текст ответа бота/ })
              .fill('Магазин нашего чата');
            assert.equal(await page.evaluate(() => window.__shopSaves.length), 0);
            await close('Кнопки в чате');
            await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            assert.equal(
              await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).inputValue(),
              'Магазин нашего чата',
              'internal Back preserves unsaved response',
            );
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            assert.equal(
              await page.evaluate(() => window.__shopSaves.at(-1).karavanStorefrontMessageText),
              'Магазин нашего чата',
            );
            await close('Кнопки в чате');
            await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
            assert.equal(
              await panel.getByRole('textbox', { name: /^Текст ответа бота/ }).inputValue(),
              'Магазин нашего чата',
            );
            await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).uncheck();
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            assert.equal(await page.evaluate(() => window.__shopSaves.length), 2);
            await shot('publications', panel);
            await close('Кнопки в чате');
            if (width === 320) {
              await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
              panel = page.getByRole('dialog', { name: 'Кнопки в чате', exact: true });
              await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).check();
              const scenario = panel.getByRole('button', {
                name: 'Без витрины',
                exact: true,
              });
              await scenario.click();
              assert.equal(await scenario.getAttribute('aria-pressed'), 'true');
              assert.equal(
                await scenario.evaluate((el) => getComputedStyle(el).color),
                'rgb(255, 255, 255)',
              );
              assert.equal(
                await panel.locator('.settings-storefront-editor__preview-button').count(),
                1,
                'chat marketplace has one catalog button',
              );
              await panel
                .getByRole('radio', { name: 'Администраторы и выбранные пользователи' })
                .check();
              await panel.locator('.settings-storefront__entry').nth(99).waitFor();
              await panel.getByRole('button', { name: 'Ещё пользователи' }).click();
              await panel.locator('.settings-storefront__entry').nth(101).waitFor();
              const longName =
                'Александра Константинопольская-Рождественская — представитель районного сообщества';
              const entry = panel
                .locator('.settings-storefront__entry')
                .filter({ hasText: longName });
              await entry.getByRole('button', { name: `Отозвать доступ: ${longName}` }).click();
              const confirmation = page.getByRole('dialog', {
                name: 'Отозвать доступ к добавлению ссылки?',
              });
              const name = confirmation.locator('.action-confirm-sheet__preview-title');
              assert.equal(await name.innerText(), longName);
              assert.ok(
                await name.evaluate(
                  (node) => node.clientWidth >= 240 && node.scrollWidth <= node.clientWidth + 1,
                ),
              );
              await page.screenshot({
                path: `${output}/${engineName}-${width}-${theme}-revoke.png`,
              });
              await confirmation
                .getByRole('button', { name: 'Отозвать доступ', exact: true })
                .click();
              await confirmation.waitFor({ state: 'detached' });
              await entry.waitFor({ state: 'detached' });
              await panel.locator('.settings-drilldown__body').evaluate((node) => {
                node.scrollTop = 250;
              });
              const scroll = await panel
                .locator('.settings-drilldown__body')
                .evaluate((node) => node.scrollTop);
              await close('Кнопки в чате');
              await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
              assert.equal(
                await panel.locator('.settings-drilldown__body').evaluate((node) => node.scrollTop),
                scroll,
                'Back restores scroll',
              );
              await page.setViewportSize({ width: 320, height: 480 });
              await page.evaluate(() => {
                document.documentElement.style.fontSize = '24px';
              });
              await panel.getByText('Изменить текст', { exact: true }).click();
              const response = panel.getByRole('textbox', { name: /^Текст ответа бота/ });
              await response.fill('Несохранённый текст');
              await response.focus();
              await shot('short-large-text', panel);
              const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
              assert.ok(
                await save.evaluate((node) => {
                  const r = node.getBoundingClientRect();
                  return r.top >= 0 && r.bottom <= innerHeight;
                }),
                'save remains visible on short viewport',
              );
              await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
              const discard = page.getByRole('dialog', { name: 'Не сохранять изменения?' });
              await discard
                .getByRole('button', { name: 'Продолжить настройку', exact: true })
                .click();
              assert.equal(await response.inputValue(), 'Несохранённый текст');
              await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
              await discard.getByRole('button', { name: 'Не сохранять', exact: true }).click();
              await page.getByRole('dialog').waitFor({ state: 'detached' });
              await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
              await home.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
              assert.equal(
                await panel.getByRole('checkbox', { name: 'Ответ бота на $' }).isChecked(),
                false,
                'explicit discard restores saved settings',
              );
              await close('Кнопки в чате');
            }
            assert.deepEqual(errors, []);
            count++;
            console.log(`Shop journey ${engineName}/${width}/${theme}: passed (${count}).`);
            if (width === 360 && theme === 'light')
              for (const scenario of [
                'empty',
                'error',
                'unbound',
                'draft',
                'draft_empty',
                'invitation_paged',
                'permission_loss',
              ]) {
                await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
                await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
                if (['draft', 'draft_empty'].includes(scenario)) {
                  await home
                    .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                    .waitFor();
                  assert.equal(
                    await home
                      .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                      .count(),
                    0,
                  );
                  assert.equal(
                    await page.evaluate(
                      () =>
                        window.__shopRequests.filter(
                          (row) => row.body?.command?.operation === 'status',
                        ).length,
                    ),
                    0,
                  );
                  await home
                    .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                    .click();
                  if (scenario === 'draft_empty') {
                    await home
                      .getByText('Открыть магазин без продавцов?', { exact: true })
                      .waitFor();
                    await home
                      .getByRole('button', { name: 'Открыть для покупателей', exact: true })
                      .last()
                      .click();
                    await home
                      .getByRole('button', { name: 'Повторить проверку', exact: true })
                      .click();
                  }
                  await home
                    .getByRole('button', { name: 'Посмотреть магазин чата', exact: true })
                    .waitFor();
                  const statusWrites = await page.evaluate(() =>
                    window.__shopRequests.filter(
                      (row) => row.body?.command?.operation === 'status',
                    ),
                  );
                  const status = statusWrites[0].body.command.input;
                  assert.equal(status.status, 'active');
                  assert.equal(status.allowEmpty, scenario === 'draft_empty');
                  if (scenario === 'draft_empty') {
                    assert.equal(statusWrites.length, 2);
                    assert.deepEqual(statusWrites[1].body, statusWrites[0].body);
                    assert.equal(
                      await home
                        .getByText('Приостановить просмотр магазина покупателями?', {
                          exact: true,
                        })
                        .count(),
                      0,
                      'successful activation retry closes its confirmation',
                    );
                  }
                  await shot(`opened-${scenario}`, home);
                  continue;
                }
                if (scenario === 'permission_loss') {
                  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
                  panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
                  await panel.getByRole('radio', { name: 'По приглашению', exact: true }).check();
                  await panel.getByRole('button', { name: 'Сохранить', exact: true }).waitFor();
                  await page.evaluate(() => window.__loseShopManage());
                  await panel
                    .getByRole('button', { name: 'Сохранить', exact: true })
                    .waitFor({ state: 'detached' });
                  assert.equal(await panel.getByRole('radio').count(), 0);
                  assert.equal(
                    await page.evaluate(
                      () =>
                        window.__shopRequests.filter(
                          (row) => row.body?.command?.operation === 'settings',
                        ).length,
                    ),
                    0,
                    'losing manage permission cannot submit an existing settings draft',
                  );
                  await shot(scenario, panel);
                  continue;
                }
                if (scenario === 'invitation_paged') {
                  await home.getByRole('button', { name: 'Настройки', exact: true }).click();
                  panel = page.getByRole('dialog', { name: 'Настройки', exact: true });
                  await panel
                    .getByRole('button', { name: 'Следующие приглашения', exact: true })
                    .click();
                  await panel
                    .getByRole('button', { name: 'В начало списка', exact: true })
                    .waitFor();
                  await page.evaluate(() => {
                    window.__dropShopInvitationUrl = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                    .click();
                  const lost = panel
                    .getByRole('alert')
                    .filter({ hasText: 'Ссылка не сохранилась.' });
                  await lost.waitFor();
                  const minted = panel
                    .locator('.karavan-shop__row')
                    .filter({ hasText: /использовано\s+0/u });
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .waitFor();
                  assert.equal(
                    await panel
                      .getByRole('button', { name: 'В начало списка', exact: true })
                      .count(),
                    0,
                    'creating on a later page returns to the new invitation',
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await lost.waitFor({ state: 'detached' });
                  await page.evaluate(() => {
                    window.__deferShopClipboard = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                    .click();
                  await page.waitForFunction(
                    () => typeof window.__finishShopClipboard === 'function',
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await page.evaluate(() => {
                    window.__dropShopInvitationUrl = true;
                  });
                  await panel
                    .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                    .click();
                  await lost.waitFor();
                  await page.evaluate(() => window.__finishShopClipboard());
                  await settleVisualFrame(page);
                  assert.equal(
                    await lost.isVisible(),
                    true,
                    'late clipboard completion cannot clear a newer lost invitation',
                  );
                  assert.equal(
                    await panel
                      .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                      .isDisabled(),
                    true,
                  );
                  await minted
                    .getByRole('button', { name: 'Отозвать приглашение', exact: true })
                    .click();
                  await lost.waitFor({ state: 'detached' });
                  await panel
                    .getByRole('button', { name: 'Скопировать приглашение', exact: true })
                    .click();
                  await panel.getByRole('button', { name: 'Скопировано', exact: true }).waitFor();
                  await shot(scenario, panel);
                  continue;
                }
                if (scenario === 'unbound') {
                  await home
                    .getByRole('button', { name: 'Подключить магазин', exact: true })
                    .click();
                  await home
                    .getByRole('radio', { name: 'Выбрать существующий', exact: true })
                    .waitFor();
                  assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
                  assert.ok(
                    (await page.evaluate(() => window.__shopRequests)).every(
                      (row) => !row.path.endsWith('/setup') && !row.path.includes('/bindings/'),
                    ),
                    'entering setup never creates or binds a marketplace',
                  );
                  await shot(scenario, home);
                  assert.deepEqual(errors, []);
                  continue;
                }
                await page.getByRole('button', { name: 'Витрины', exact: true }).click();
                panel = page.getByRole('dialog', { name: 'Витрины', exact: true });
                await panel.getByRole('tab', { name: 'Товары и услуги', exact: true }).click();
                if (scenario === 'error') {
                  await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
                  await panel.getByRole('button', { name: 'Закрепить', exact: true }).waitFor();
                } else await panel.getByText('Товаров и услуг пока нет').waitFor();
                await shot(scenario, panel);
                assert.deepEqual(errors, []);
              }
          } catch (error) {
            const page = context.pages()[0];
            if (page) {
              await page.screenshot({ path: `${output}/failure.png` });
              console.error((await page.locator('body').innerText()).slice(-5000));
            }
            throw error;
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
  console.log(
    `Shop management browser: ${count} phone/theme/engine journeys passed. Screenshots: ${output}`,
  );
} finally {
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
