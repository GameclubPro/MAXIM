import assert from 'node:assert/strict';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const baseUrl = 'http://127.0.0.1:3000/app/';
const server = await ensureMiniappDevServer(baseUrl);
const screenshots = await mkdtemp(path.join(tmpdir(), 'maxim-video-picker-'));
const oversizedPath = path.join(screenshots, 'oversized.mp4');
const oversizedFile = await open(oversizedPath, 'wx');
await oversizedFile.truncate(100_000_001);
await oversizedFile.close();
let browser;

try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme] of [
    ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light'],
    ['desktop-dark', { viewport: { width: 1280, height: 900 } }, 'dark'],
    ['iphone-light', devices['iPhone 15'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
    ['iphone-se-light', devices['iPhone SE'], 'light'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    try {
      let binaryMode = 'success';
      let binaryRequests = 0;
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'preview.okcdn.ru') {
          if (route.request().method() === 'POST') binaryRequests += 1;
          if (binaryMode === 'slow') await new Promise((resolve) => setTimeout(resolve, 2000));
          return route
            .fulfill({
              status: binaryMode === 'failure' ? 503 : 200,
              body: '',
              headers: {
                'access-control-allow-origin': new URL(baseUrl).origin,
                'access-control-allow-methods': 'POST, OPTIONS',
                'access-control-allow-headers': '*',
              },
            })
            .catch(() => undefined);
        }
        return url.origin === new URL(baseUrl).origin ? route.continue() : route.abort();
      });
      await installMaxBridgeShimInitScript(context, {}, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${baseUrl}publications?preview=1&profile=publisher&compose=1`);
      const input = page.locator('.publication-video-tool input');
      await input.waitFor();
      await applyNativeVisualMode(page, {
        safeTop: name.startsWith('iphone') ? 59 : name.startsWith('android') ? 24 : 0,
        safeBottom: name.startsWith('iphone') ? 34 : 0,
      });
      const editor = page.getByRole('textbox', { name: 'Текст публикации', exact: true });
      await editor.fill('Video attachment regression');
      const error = page.locator('.publication-video-error');
      const tooLarge = oversizedPath;
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });
      assert.match(await error.textContent(), /Максимум 100 МБ/u);
      assert.equal(binaryRequests, 0);
      assert.equal(await input.getAttribute('aria-invalid'), 'true');
      assert.ok(
        (await input.getAttribute('aria-describedby')).includes(await error.getAttribute('id')),
      );
      await page.waitForTimeout(3500);
      assert.equal(await error.isVisible(), true, 'Error must outlive the old toast timeout');
      await editor.fill('Video attachment regression edited');
      assert.equal(await error.isVisible(), true, 'Editing text must not erase the media error');
      await input.setInputFiles([]);
      assert.equal(await error.isVisible(), true, 'Cancelling the picker must preserve the error');
      await error.scrollIntoViewIfNeeded();
      const layout = await error.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          fits:
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            element.scrollWidth <= element.clientWidth,
          unobscured: element.contains(
            document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2),
          ),
        };
      });
      assert.deepEqual(layout, { fits: true, unobscured: true });
      await page.screenshot({ path: path.join(screenshots, `${name}-error.png`) });
      assert.equal(await input.inputValue(), '');
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });

      const smallVideo = {
        name: 'small.mp4',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from('video'),
      };
      await input.setInputFiles(smallVideo);
      await error.waitFor({ state: 'detached' });
      const selected = page.locator('.publication-retained-media');
      await selected.waitFor({ state: 'visible' });
      assert.match(await selected.textContent(), /small.mp4/u);
      assert.equal(await input.getAttribute('aria-invalid'), null);
      await input.setInputFiles(tooLarge);
      await error.waitFor({ state: 'visible' });
      assert.match(
        await selected.textContent(),
        /small.mp4/u,
        'Failed replacement must keep the previous video',
      );
      assert.match(await editor.textContent(), /regression edited/u);

      await input.setInputFiles({
        name: 'empty.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(0),
      });
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('Видео пустое'),
      );
      await input.setInputFiles(smallVideo);
      await error.waitFor({ state: 'detached' });
      await selected.waitFor({ state: 'visible' });
      await page.locator('.publication-video-upload').waitFor({ state: 'detached' });
      binaryMode = 'failure';
      await input.setInputFiles(smallVideo);
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('MAX не принял'),
      );
      assert.match(await selected.textContent(), /small.mp4/u);
      binaryMode = 'slow';
      await input.setInputFiles(smallVideo);
      await page.getByRole('button', { name: 'Отменить загрузку видео', exact: true }).click();
      await page.waitForFunction(() =>
        document.querySelector('.publication-video-error')?.textContent.includes('отменена'),
      );
      assert.match(await selected.textContent(), /small.mp4/u);
      binaryMode = 'success';
      await input.setInputFiles({
        name: '36mb.mp4',
        mimeType: 'video/mp4',
        buffer: Buffer.alloc(36_000_000),
      });
      await page.waitForFunction(() =>
        document.querySelector('.publication-retained-media')?.textContent.includes('36mb.mp4'),
      );
      assert.equal(await error.count(), 0);
      assert.equal(
        await page.getByRole('button', { name: 'Убрать видео', exact: true }).count(),
        1,
      );
      await page.screenshot({ path: path.join(screenshots, `${name}-attached.png`) });
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${name}: 36 MB direct upload, 100 MB limit, persistent error, cancel, retry, generic MIME, empty, preserved draft`,
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
