import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
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
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3015/app/');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
const output = '/tmp/maxim-moderator-choice';
mkdirSync(output, { recursive: true });
try {
  for (const [width, height, platform, theme] of [
    [320, 568, 'ios', 'light'],
    [393, 851, 'android', 'dark'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('?preview=1&view=chat', base).href);
    const row = page.locator('.chat-card').first();
    const trigger = row.locator('.chat-card__moderator-control');
    await row.waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: platform === 'android' ? 24 : 0 });
    await trigger.waitFor({ timeout: 12000 }).catch(async (error) => {
      await page.screenshot({ path: `${output}/failed-home.png` });
      throw error;
    });
    await page.evaluate(async () => {
      const moduleUrl = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`)).name;
      const { PREVIEW_REQUEST_HANDLERS } = await import(moduleUrl('preview-transport.ts'));
      const { PREVIEW_NOT_HANDLED } = await import(moduleUrl('preview-transport-runtime.ts'));
      const { handleModeratorPreviewRequest } = await import(
        moduleUrl('preview-transport-moderator.ts')
      );
      window.__moderatorPosts = [];
      window.__loseModeratorReply = true;
      PREVIEW_REQUEST_HANDLERS.unshift(async (request) => {
        if (request.method !== 'POST' || !request.url.pathname.endsWith('/moderator'))
          return PREVIEW_NOT_HANDLED;
        window.__moderatorPosts.push(JSON.parse(request.init.body));
        const result = await handleModeratorPreviewRequest(request);
        if (window.__loseModeratorReply) {
          window.__loseModeratorReply = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error('Network response lost');
        }
        return result;
      });
    });
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: 'Бот сообщества' });
    await sheet.getByText('Сейчас выбран', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('radio', { name: /Максимов 2/ }).isDisabled(), true);
    await sheet.getByRole('radio', { name: /Максимова/ }).check();
    assert.match(await trigger.innerText(), /Максимов(?:\n|$)/);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 160)));
    await page.screenshot({ path: `${output}/${platform}-${theme}-selection.png`, fullPage: true });
    const button = sheet.getByRole('button', { name: 'Сменить бота', exact: true });
    await button.dblclick();
    await sheet.getByRole('button', { name: 'Проверить смену' }).waitFor();
    assert.equal((await page.evaluate(() => window.__moderatorPosts)).length, 1);
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await trigger.evaluate((el) => document.activeElement === el), true);
    await trigger.click();
    await sheet.waitFor({ state: 'hidden' });
    await page.waitForFunction(() =>
      document.querySelector('.chat-card__moderator-control')?.textContent.includes('Максимова'),
    );
    assert.equal((await page.evaluate(() => window.__moderatorPosts)).length, 1);
    await trigger.click();
    await sheet.getByText('Сейчас выбран', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('radio', { name: /Максимова/ }).isChecked(), true);
    assert.equal(
      await sheet.getByRole('button', { name: 'Сменить бота', exact: true }).isDisabled(),
      true,
    );
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({ path: `${output}/${platform}-${theme}-home.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${platform} ${theme}: preview, rights, repeated tap, lost response, reopen recovery, native Back, focus`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
}
