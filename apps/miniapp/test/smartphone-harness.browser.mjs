import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import {
  resolveCaptureDevice,
  readCaptureGeometry,
  setPhoneKeyboard,
  capturePhoneScreenshot,
} from '../../../scripts/miniapp-smartphone.mjs';
import { applyNativeVisualMode } from '../../../scripts/miniapp-native-visual-mode.mjs';

const output = await mkdtemp(join(tmpdir(), 'maxim-phone-harness-'));
try {
  for (const key of ['android', 'iphone', 'iphone-se']) {
    const capture = resolveCaptureDevice(presets[key]);
    const browser = await { chromium, webkit }[capture.browserName].launch();
    try {
      const context = await browser.newContext(capture.contextOptions);
      const page = await context.newPage();
      await page.setContent(
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:rgb(36,99,235)}input{margin:20px;width:200px;height:44px}</style><input aria-label="Search">',
      );
      await applyNativeVisualMode(page, capture.profile);
      const before = await readCaptureGeometry(page);
      assert.deepEqual(before.layout, capture.phone.viewport);
      assert.deepEqual(before.screen, capture.contextOptions.screen);
      assert.equal(before.deviceScaleFactor, capture.contextOptions.deviceScaleFactor);
      assert.equal(before.coarsePointer, true);
      await page.locator('input').evaluate((node) =>
        node.addEventListener('touchstart', () => {
          node.dataset.touched = 'true';
        }),
      );
      await page.locator('input').tap();
      assert.equal(await page.locator('input').getAttribute('data-touched'), 'true');
      await page.locator('input').click();
      const stylesBefore = await page.locator('style').count();
      for (const mode of ['visual', 'resize']) {
        for (let cycle = 0; cycle < 3; cycle += 1) {
          const keyboard = await setPhoneKeyboard(page, { mode, height: 260 });
          const reduced = await readCaptureGeometry(page);
          assert.ok(Math.abs(reduced.visual.height - keyboard.viewportHeight) <= 1);
          if (mode === 'visual') assert.deepEqual(reduced.layout, before.layout);
          if (mode === 'visual' || capture.browserName === 'chromium')
            assert.deepEqual(reduced.screen, before.screen);
          assert.equal(
            await page.locator('input').evaluate((node) => node === document.activeElement),
            true,
          );
          assert.equal(await page.locator('style').count(), stylesBefore);
          await setPhoneKeyboard(page, { mode, open: false });
          const restored = await readCaptureGeometry(page);
          assert.deepEqual(restored.layout, before.layout);
          assert.ok(Math.abs(restored.visual.height - before.visual.height) <= 1);
        }
      }
      const path = join(output, `${key}.png`);
      await capturePhoneScreenshot(browser, page, capture, path);
      const png = await readFile(path);
      assert.equal(
        png.readUInt32BE(16),
        Math.round(capture.phone.width * before.deviceScaleFactor),
      );
      assert.equal(
        png.readUInt32BE(20),
        Math.round(capture.phone.height * before.deviceScaleFactor),
      );
      const color = await page.evaluate(
        async ({ source, x, y }) => {
          const image = new Image();
          image.src = source;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(image, 0, 0);
          return [...ctx.getImageData(x, y, 1, 1).data];
        },
        {
          source: `data:image/png;base64,${png.toString('base64')}`,
          x: Math.round(5 * before.deviceScaleFactor),
          y: Math.round(
            (capture.phone.statusBarHeight + capture.phone.headerHeight + 5) *
              before.deviceScaleFactor,
          ),
        },
      );
      assert.deepEqual(
        color,
        [36, 99, 235, 255],
        'phone composition must preserve actual WebView pixels',
      );
      console.log(
        `PASS ${key}: ${capture.browserName}, actual viewport, touch, DPR, keyboard cycles, screenshot size and pixels`,
      );
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(output, { recursive: true, force: true });
}
