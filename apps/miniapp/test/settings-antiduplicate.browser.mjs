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

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-antiduplicate-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of [
    ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
    ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
    ['android-light', devices['Pixel 7'], 'light', 'android'],
    ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
      await installNativeVisualModeInitScript(context);
      await context.route('**/antiduplicate-test', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
        import RefreshRuntime from '/app/@react-refresh';
        RefreshRuntime.injectIntoGlobalHook(window);
        window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
        window.__vite_plugin_react_preamble_installed__=true;
        await import('/app/test/fixtures/settings-antiduplicate-harness.tsx');
      </script></body></html>`,
        }),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      const writes = [];
      const previews = [];
      let saved;
      let responseStatus = 500;
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (!pathname.startsWith('/api/')) return route.continue();
        const screen = await page.evaluate(() => window.__ANTIDUPLICATE_SCREEN__);
        saved ??= screen.settings;
        if (request.method() === 'GET' && pathname === '/api/chats/chat-a/settings-screen') {
          await route.fulfill({ json: { ...screen, settings: saved } });
          return;
        }
        if (request.method() === 'POST' && pathname.endsWith('/settings/apply-section-preview')) {
          previews.push(request.postDataJSON());
          await route.fulfill({
            json: {
              sourceChatId: 'chat-a',
              targetMode: 'current',
              updatedChats: 1,
              appliedChatIds: ['chat-a'],
              sampleChats: [],
            },
          });
          return;
        }
        writes.push({ pathname, method: request.method(), body: request.postDataJSON() });
        if (pathname !== '/api/chats/chat-a/settings/section' || request.method() !== 'PATCH') {
          await route.fulfill({ status: 500, json: { message: 'Unexpected mutation' } });
          return;
        }
        if (responseStatus === 200) {
          saved = {
            ...saved,
            ...request.postDataJSON().changes,
            settingsRevision: '2026-10-04T02:00:00.000Z',
          };
          await route.fulfill({ json: saved });
        } else {
          if (responseStatus === 409)
            saved = {
              ...saved,
              settingsRevision: '2026-10-04T01:00:00.000Z',
              duplicateCompareMode: 'MESSAGE',
            };
          await route.fulfill({
            status: responseStatus,
            json: {
              message: 'Не удалось сохранить',
              code: responseStatus === 409 ? 'CHAT_SETTINGS_CONCURRENT_UPDATE' : 'INTERNAL_ERROR',
            },
          });
        }
      });
      await page.goto(`${base}antiduplicate-test`);
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
      }, colorScheme);
      await page.getByRole('button', { name: 'Антидубль', exact: true }).click();
      await applyNativeVisualMode(page, {
        safeTop: platform === 'ios' ? 44 : 24,
        safeBottom: platform === 'ios' ? 34 : 0,
      });
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      const compare = panel.getByRole('combobox', { name: 'Сравнение сообщений' });
      const master = panel.locator('label[aria-label="Включить антидубль"] input');
      await master.uncheck();
      assert.equal(await compare.count(), 0);
      await master.check();
      await panel.getByRole('button', { name: 'Применить к другим чатам', exact: true }).click();
      const currentTarget = page.getByRole('button', { name: 'Этот чат', exact: true });
      assert.equal(await currentTarget.getAttribute('aria-pressed'), 'true');
      assert.equal(
        await page
          .getByRole('button', { name: 'Все чаты', exact: true })
          .getAttribute('aria-pressed'),
        'false',
      );
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await currentTarget.waitFor({ state: 'hidden' });
      assert.equal(await compare.isVisible(), true);
      assert.equal(writes.length, 0);
      const scope = panel.getByRole('radiogroup', { name: 'Чьи картинки сравнивать' });
      await scope.getByRole('radio', { name: 'Всех участников', exact: true }).click();
      await compare.selectOption('TEXT');
      assert.equal(await scope.count(), 0);
      await compare.selectOption('MESSAGE');
      assert.equal(
        await scope
          .getByRole('radio', { name: 'Всех участников', exact: true })
          .getAttribute('aria-checked'),
        'true',
      );
      const interval = panel.getByRole('spinbutton', { name: 'Период проверки дублей, часы' });
      await interval.fill('12');
      await interval.press('Tab');
      await panel.getByRole('radio', { name: 'По времени', exact: true }).click();
      const start = panel.getByRole('button', { name: 'С: 09:00', exact: true });
      await start.click();
      await page
        .getByRole('listbox', { name: 'Часы' })
        .getByRole('option', { name: '23', exact: true })
        .click();
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await page.getByRole('listbox', { name: 'Часы' }).waitFor({ state: 'hidden' });
      assert.equal(await start.isVisible(), true, 'Native Back cancels time editing only');
      await start.click();
      await page
        .getByRole('listbox', { name: 'Часы' })
        .getByRole('option', { name: '23', exact: true })
        .click();
      await page.getByRole('button', { name: 'Применить', exact: true }).click();
      await panel.getByRole('combobox', { name: 'Часовой пояс' }).selectOption('Asia/Vladivostok');
      await compare.selectOption('TEXT');
      await panel
        .getByText('Ежедневно, с переходом на следующий день.', { exact: false })
        .waitFor();
      const save = panel.getByRole('button', { name: 'Сохранить', exact: true });
      const submit = async () => {
        const received = page.waitForResponse((response) =>
          response.url().endsWith('/settings/section'),
        );
        await save.click();
        await received;
        if (responseStatus === 409) {
          await panel
            .getByRole('button', { name: 'Сравнить с сохранённым', exact: true })
            .waitFor();
        } else {
          await save.waitFor();
        }
      };
      await submit();
      assert.equal(await compare.inputValue(), 'TEXT');
      assert.equal(
        await panel.getByRole('button', { name: 'С: 23:00', exact: true }).isVisible(),
        true,
      );
      responseStatus = 409;
      await submit();
      const closeToast = page.getByRole('button', { name: 'Закрыть уведомление', exact: true });
      while (await closeToast.count()) await closeToast.first().click();
      await page.screenshot({ path: path.join(screenshots, `${name}-conflict.png`) });
      await panel.getByRole('button', { name: 'Сравнить с сохранённым', exact: true }).click();
      assert.equal(await compare.inputValue(), 'MESSAGE');
      await panel.getByRole('button', { name: 'Показать мой черновик', exact: true }).click();
      assert.equal(await compare.inputValue(), 'TEXT');
      responseStatus = 200;
      const succeeded = page.waitForResponse(
        (response) => response.url().endsWith('/settings/section') && response.status() === 200,
      );
      await panel.getByRole('button', { name: 'Сохранить мой вариант', exact: true }).click();
      await succeeded;
      await panel
        .getByRole('button', { name: 'Сохранить мой вариант', exact: true })
        .waitFor({ state: 'hidden' });
      assert.equal(writes.length, 3);
      assert.ok(previews.length > 0);
      assert.ok(previews.every((preview) => preview.target.mode === 'current'));
      assert.ok(
        writes.every(
          (write) =>
            write.pathname === '/api/chats/chat-a/settings/section' && write.method === 'PATCH',
        ),
      );
      const final = writes.at(-1).body;
      assert.equal(final.section, 'duplicates');
      assert.equal(final.expectedRevision, '2026-10-04T01:00:00.000Z');
      assert.equal(final.changes.duplicateCompareMode, 'TEXT');
      assert.equal(final.changes.duplicatePhotoScope, 'CHAT');
      assert.equal(final.changes.duplicateWindowMode, 'DAILY');
      assert.equal(final.changes.duplicateStartTimeMinutes, 1380);
      assert.equal(final.changes.duplicateEndTimeMinutes, 1080);
      assert.equal(final.changes.duplicateTimezone, 'Asia/Vladivostok');
      assert.equal(final.changes.duplicateWarnWindowSec, 43200);
      assert.equal('rules' in final.changes, false);
      await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
      await panel.waitFor({ state: 'hidden' });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: real anti-duplicate controls, DAILY/timezone, native Back, 500/409 draft retention, current-chat request and manual-rule preservation`,
      );
    } finally {
      await context.close();
    }
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
