import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

// Keep the real route, shared fields, draft state and save handler together.
// Only the local preview transport supplies synthetic marketplace responses.
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const output = await mkdtemp('/tmp/maxim-shop-route-');
const server = await ensureMiniappDevServer(base);
try {
  for (const [engineName, engine, width, theme] of [
    ['chromium', chromium, 360, 'dark'],
    ['webkit', webkit, 390, 'light'],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      const context = await browser.newContext({
        viewport: { width, height: 780 },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        {
          platform: engineName === 'webkit' ? 'ios' : 'android',
        },
        { colorScheme: theme },
      );
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
        const response = await route.fetch();
        const source = await response.text();
        const marker = 'for (const handler of handlers) {';
        assert.ok(source.includes(marker));
        await route.fulfill({
          response,
          body: source.replace(
            marker,
            `
          if (context.url.pathname.endsWith('/karavan-marketplace')) {
            const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
            const binding = {id, chatId: '-123', chatTitle: 'Соседи',
              state: 'verified', generation: 1, revision: 1, verifiedAt: new Date().toISOString()};
            return {enabled: true, actorMaxUserId: '777', sellerBotUrl: 'https://max.ru/synthetic_seller_bot',
              setupOperation: null, publicationChoices: [], currentChatTitle: 'Соседи',
              marketplace: {id, networkId: id, publicSlug: 'synthetic-shop', name: 'Магазин соседей',
                description: null, kind: 'chat', status: 'active', admissionPolicy: 'applications',
                logoImageUrl: null, coverImageUrl: null, editRevision: 1, policyRevision: 1,
                orderRevision: 1, visibilityRevision: 1}, binding, bindings: [binding],
              permissions: ['manage_marketplace','review_listing','arrange_listings','bind_chat'],
              counts: {listings: 2, readyListings: 2, pendingApplications: 1, chats: 1}, canManage: true,
              publicationPreview: {mode: 'chat_marketplace'}, buyerUrl: 'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop', previewUrl: null};
          }
          ${marker}`,
          ),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      try {
        await page.goto(`${base}?preview=1&profile=moderation&view=chat`);
        await page.locator('.chat-card__action--settings').first().click();
        await applyNativeVisualMode(page, {
          safeTop: 0,
          safeBottom: engineName === 'webkit' ? 34 : 24,
        });
        await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
        const home = page.getByRole('dialog', { name: 'Интернет-витрина', exact: true });
        await home.getByRole('button', { name: 'Посмотреть магазин', exact: true }).waitFor();
        assert.equal(await home.locator('.karavan-shop__menu button').count(), 6);
        assert.equal(await home.locator('#karavanStorefrontMessageText').count(), 0);
        await settleVisualFrame(page);
        await page.screenshot({ path: `${output}/${engineName}-home.png` });
        await home.getByRole('button', { name: 'Кнопка в чате', exact: true }).click();
        const publications = page.getByRole('dialog', { name: 'Кнопка в чате', exact: true });
        await publications.getByRole('checkbox', { name: 'Ответ бота на $' }).check();
        const message = publications.getByRole('textbox', { name: /^Текст ответа бота/ });
        await message.fill('Объявления нашего чата');
        await page.evaluate(() => {
          Object.defineProperty(window.visualViewport, 'height', {
            configurable: true,
            value: 360,
          });
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await settleVisualFrame(page);
        await message.focus();
        const save = publications.getByRole('button', { name: 'Сохранить', exact: true });
        assert.ok(
          await save.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return rect.height >= 48 && rect.top >= 0 && rect.bottom <= 360;
          }),
          'save stays above keyboard with a 48px target',
        );
        assert.ok(
          await message.evaluate((node) => {
            const field = node.getBoundingClientRect();
            const body = node.closest('.settings-drilldown__body').getBoundingClientRect();
            return field.top >= body.top - 1 && field.bottom <= body.bottom + 1;
          }),
          'focused input stays inside visible scroll area',
        );
        await page.screenshot({ path: `${output}/${engineName}-keyboard.png` });
        await page.evaluate(() => {
          delete window.visualViewport.height;
          window.visualViewport.dispatchEvent(new Event('resize'));
        });
        await settleVisualFrame(page);
        await publications.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await page.getByText('Блок «Интернет-витрина» сохранен', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
        await home.getByRole('button', { name: 'Кнопка в чате', exact: true }).click();
        assert.equal(await message.inputValue(), 'Объявления нашего чата');
        await settleVisualFrame(page);
        assert.ok(await publications.evaluate((node) => node.scrollWidth <= node.clientWidth + 1));
        await page.screenshot({ path: `${output}/${engineName}-publications.png` });
        assert.deepEqual(errors, []);
        console.log(
          `Shop actual route: ${engineName}/${width}/${theme} passed. Screenshots: ${output}`,
        );
      } catch (error) {
        await page.screenshot({ path: `${output}/${engineName}-failure.png` });
        console.error((await page.locator('body').innerText()).slice(-4000));
        throw error;
      } finally {
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}
