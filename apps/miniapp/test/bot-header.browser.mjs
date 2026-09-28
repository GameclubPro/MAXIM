import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
const output = mkdtempSync(join(tmpdir(), 'maxim-bot-header-'));
const bots = [
  ['maximov', 'Майор Максимов', 'moderation'],
  ['maximova', 'Майор Максимова', 'moderation'],
  ['rex', 'Рэкс', 'moderation'],
  ['publik', 'Публик', 'publisher'],
];
const browser = await chromium.launch();

async function checkHeader(page, profile, name, key) {
  const selector =
    profile === 'publisher' ? '.publisher-entities-page__brand' : '.chats-command__identity';
  const header = page.locator(selector);
  await header.waitFor();
  const headerBounds = await header.boundingBox();
  assert.ok(headerBounds.height <= 84, `${name}: header is too tall`);
  if (profile === 'moderation') {
    const shellBounds = await page.locator('.app-shell').boundingBox();
    assert.ok(Math.abs(headerBounds.x - shellBounds.x) <= 1, 'header left edge has a gap');
    assert.ok(Math.abs(headerBounds.width - shellBounds.width) <= 1, 'header right edge has a gap');
  }
  assert.equal(await header.locator('h1').innerText(), name);
  const img = header.locator('img');
  await img.evaluate((el) => el.decode());
  assert.equal(await img.evaluate((el) => el.naturalWidth), 192);
  assert.ok((await img.getAttribute('src')).includes(key));
  assert.equal(
    await header.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const childrenFit = [...el.querySelectorAll('h1, img, button')].every((child) => {
        const childRect = child.getBoundingClientRect();
        return (
          childRect.left >= rect.left - 1 &&
          childRect.right <= rect.right + 1 &&
          childRect.top >= rect.top - 1 &&
          childRect.bottom <= rect.bottom + 1 &&
          child.scrollWidth <= child.clientWidth + 1
        );
      });
      let ancestor = el.parentElement;
      while (ancestor) {
        const overflow = getComputedStyle(ancestor).overflowX;
        if (['hidden', 'clip', 'auto', 'scroll'].includes(overflow)) {
          const bounds = ancestor.getBoundingClientRect();
          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) return false;
        }
        ancestor = ancestor.parentElement;
      }
      return childrenFit;
    }),
    true,
    `${name}: header or its content is clipped`,
  );
}

try {
  for (const width of [320, 393, 412, 1280]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 811 },
        colorScheme: theme,
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: width === 412 ? 'android' : 'ios' },
        { colorScheme: theme },
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const [key, name, profile] of bots) {
        const url = new URL(base);
        url.search = new URLSearchParams({
          preview: '1',
          device: width === 412 ? 'android' : 'iphone-se',
          profile,
          previewBot: key,
        }).toString();
        await page.goto(url.href);
        const header =
          profile === 'publisher' ? '.publisher-entities-page__brand' : '.chats-command__identity';
        await page.locator(header).waitFor({ state: 'attached' });
        if (width === 1280) await checkHeader(page, profile, name, key);
        await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
        await page.evaluate(() => document.fonts.ready);
        await checkHeader(page, profile, name, key);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          true,
        );
        await page.screenshot({
          path: join(output, `${key}-${width}-${theme}.png`),
          animations: 'disabled',
        });
        if (width === 320) {
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
          });
          await checkHeader(page, profile, name, key);
          await page.screenshot({
            path: join(output, `${key}-${width}-${theme}-large-text.png`),
            animations: 'disabled',
          });
        }
        console.log(`PASS ${name}, ${width}px, ${theme}: correct avatar/name, unclipped header`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(`Bot header screenshots: ${output}`);
} finally {
  await browser.close();
}
