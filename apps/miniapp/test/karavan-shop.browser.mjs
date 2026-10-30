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
        : [320, 360, 390, 430])
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height: 780 },
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
            await home.getByRole('button', { name: 'Каталог', exact: true }).waitFor();
            assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
            assert.equal(await home.locator('.karavan-shop__menu button').count(), 6);
            assert.equal(
              await home
                .getByRole('button', { name: 'Посмотреть магазин', exact: true })
                .evaluate((el) => getComputedStyle(el).color),
              'rgb(255, 255, 255)',
              'primary action contrast',
            );
            await home.getByRole('button', { name: 'Посмотреть магазин', exact: true }).click();
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
                        !['checkbox', 'file'].includes(control.type),
                    )
                    .every((control) => control.getBoundingClientRect().height >= 43),
                ),
                `${name}: touch size`,
              );
              await page.screenshot({
                path: `${output}/${engineName}-${width}-${theme}-${name}.png`,
              });
            };
            const close = async (name) =>
              page
                .getByRole('dialog', { name, exact: true })
                .getByRole('button', { name: 'Закрыть панель', exact: true })
                .click();
            await shot('home', home);
            await home.getByRole('button', { name: 'Каталог', exact: true }).click();
            let panel = page.getByRole('dialog', { name: 'Каталог', exact: true });
            await panel.getByRole('button', { name: 'Закрепить', exact: true }).click();
            await panel.getByText('Закреплённые · 1', { exact: true }).waitFor();
            await panel.getByRole('button', { name: 'Скрыть', exact: true }).click();
            await panel.getByLabel('Причина', { exact: true }).fill('Не соответствует правилам');
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).click();
            await panel.getByRole('button', { name: 'Показать', exact: true }).waitFor();
            await shot('catalog', panel);
            await close('Каталог');
            await home.getByRole('button', { name: 'Оформление', exact: true }).click();
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
            await panel.getByRole('button', { name: 'Сохранить черновик', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Применить оформление', exact: true })
              .waitFor();
            assert.equal(await page.evaluate(() => window.__shopPublished.name), 'Магазин соседей');
            await panel.getByRole('button', { name: 'Посмотреть магазин', exact: true }).click();
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
            await home.getByRole('button', { name: 'Категории', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Категории', exact: true });
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
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).waitFor();
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
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).click();
            await panel.getByRole('button', { name: 'Обновить данные', exact: true }).click();
            await panel.getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
            assert.equal(
              await panel.getByRole('button', { name: 'Подтвердить', exact: true }).count(),
              0,
            );
            assert.equal(
              await panel.getByRole('checkbox', { name: 'Ремонт', exact: true }).isChecked(),
              false,
            );
            await panel.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).waitFor();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__shopRequests
                    .filter((row) => row.body?.command?.operation === 'rules_preview')
                    .at(-1).body.command.input.expectedPolicyRevision,
              ),
              2,
            );
            await panel.getByRole('button', { name: 'Подтвердить', exact: true }).click();
            await panel
              .getByRole('button', { name: 'Подтвердить', exact: true })
              .waitFor({ state: 'detached' });
            await shot('categories', panel);
            await close('Категории');
            await home.getByRole('button', { name: 'Заявки', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Заявки', exact: true });
            await panel.getByRole('button', { name: 'Принять', exact: true }).click();
            await panel.getByText('Новых заявок нет').waitFor();
            await close('Заявки');
            await home.getByRole('button', { name: 'Публикации', exact: true }).click();
            panel = page.getByRole('dialog', { name: 'Публикации', exact: true });
            await panel
              .getByRole('textbox', { name: /^Текст сообщения/ })
              .fill('Магазин нашего чата');
            assert.equal(await page.evaluate(() => window.__shopSaves.length), 0);
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            assert.equal(
              await page.evaluate(() => window.__shopSaves.at(-1).karavanStorefrontMessageText),
              'Магазин нашего чата',
            );
            await close('Публикации');
            await home.getByRole('button', { name: 'Публикации', exact: true }).click();
            assert.equal(
              await panel.getByRole('textbox', { name: /^Текст сообщения/ }).inputValue(),
              'Магазин нашего чата',
            );
            await panel
              .getByRole('checkbox', { name: 'Включить кнопку витрины Караван' })
              .uncheck();
            await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
            assert.equal(await page.evaluate(() => window.__shopSaves.length), 2);
            await shot('publications', panel);
            await close('Публикации');
            assert.deepEqual(errors, []);
            count++;
            if (width === 360 && theme === 'light')
              for (const scenario of ['empty', 'error', 'unbound']) {
                await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
                await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
                if (scenario === 'unbound') {
                  await home
                    .getByRole('button', { name: 'Подключить магазин', exact: true })
                    .click();
                  await home
                    .getByRole('radio', { name: 'Выбрать существующий', exact: true })
                    .waitFor();
                  assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
                  assert.ok(
                    (await page.evaluate(() => window.__shopRequests)).every((row) => !row.body),
                    'entering setup never creates or binds a marketplace',
                  );
                  await shot(scenario, home);
                  assert.deepEqual(errors, []);
                  continue;
                }
                await page.getByRole('button', { name: 'Каталог', exact: true }).click();
                panel = page.getByRole('dialog', { name: 'Каталог', exact: true });
                if (scenario === 'error') {
                  await panel.getByRole('button', { name: 'Повторить', exact: true }).click();
                  await panel.getByRole('button', { name: 'Закрепить', exact: true }).waitFor();
                } else await panel.getByText('Объявлений пока нет').waitFor();
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
