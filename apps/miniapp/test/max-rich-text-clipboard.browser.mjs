import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:5175/app/';
const screenshotDir = mkdtempSync(join(tmpdir(), 'maxim-rich-text-'));
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height, theme] of [
    ['iphone-light', 390, 844, 'light'],
    ['iphone-dark', 390, 844, 'dark'],
    ['android-light', 412, 915, 'light'],
    ['android-dark', 412, 915, 'dark'],
    ['desktop-light', 1280, 900, 'light'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('test/browser/rich-text.html', base).href);
    await page.evaluate((theme) => {
      document.documentElement.dataset.maxTheme = theme;
    }, theme);
    const editor = page.getByRole('textbox', { name: 'Greeting' });
    await editor.waitFor();
    const paste = async (html) => {
      await editor.focus();
      await editor.evaluate((element, html) => {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(element);
        selection.removeAllRanges();
        selection.addRange(range);
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/html', html);
        clipboardData.setData('text/plain', 'Welcome. Read the rules.');
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
        );
      }, html);
    };
    await paste(
      '<div style="background: rgb(255,255,255)"><b>Welcome</b><br><span style="background-color: #202020">Read the <a href="https://max.ru/test">rules</a>.</span></div>',
    );
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="markdown"]').textContent.includes('rules'),
    );
    assert.equal(
      await page.getByTestId('markdown').textContent(),
      '**Welcome**\nRead the [rules](https://max.ru/test).',
    );
    assert.equal(await editor.locator('mark').count(), 0);
    assert.equal(await editor.locator('strong').textContent(), 'Welcome');
    await page.screenshot({ path: join(screenshotDir, `${name}-paste.png`) });
    await paste('<div style="background: white">Normal <mark><b>Important</b></mark></div>');
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="markdown"]').textContent.includes('Important'),
    );
    assert.equal(await page.getByTestId('markdown').textContent(), 'Normal ^^**Important**^^');
    await page.locator('.max-markdown-preview mark').waitFor();
    const styles = await page.locator('mark').evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return { color: style.color, background: style.backgroundColor };
      }),
    );
    assert.equal(styles.length, 2);
    assert.deepEqual(styles[0], styles[1]);
    assert.equal(styles[0].background, 'rgba(0, 0, 0, 0)');
    const [red, green, blue] = styles[0].color.match(/\d+/g).map(Number);
    assert.ok(red > green && red > blue, `${name}: highlight must visibly be red`);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({ path: join(screenshotDir, `${name}-highlight.png`) });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS ${name}: paste, serialized value, formatting, preview and layout`);
  }
  console.log(`Screenshots: ${screenshotDir}`);
} finally {
  await browser.close();
}
