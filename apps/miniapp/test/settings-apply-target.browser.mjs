import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/';
const screenshotDir = mkdtempSync(join(tmpdir(), 'maxim-settings-apply-'));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/settings-apply-target-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/app/test/fixtures/settings-apply-target-harness.tsx');
  </script></body></html>`,
  }),
);

const fresh = async () => {
  await page.goto(new URL('settings-apply-target-test', base).href);
  await page.getByRole('dialog').waitFor();
};
const actions = () => page.evaluate(() => window.settingsApplyTargetTest.actions);
const resolvePreview = async () => {
  await page.evaluate(() => window.settingsApplyTargetTest.resolvePreview());
  await page.locator('.settings-apply-target__actions .button--accent:enabled').waitFor();
};
const confirmButton = () => page.locator('.settings-apply-target__actions .button--accent');

try {
  await fresh();
  assert.equal(await confirmButton().isEnabled(), true);
  await page.getByRole('button', { name: 'Все чаты', exact: true }).click();
  assert.equal(await confirmButton().isDisabled(), true);
  assert.match(await page.locator('.settings-apply-target__preview').innerText(), /Проверяем/u);
  await resolvePreview();
  await confirmButton().click();
  await page.getByRole('button', { name: 'Сохраняем…', exact: true }).waitFor();
  for (const button of await page.locator('.settings-apply-target button').all()) {
    assert.equal(await button.isDisabled(), true);
  }
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        window.settingsApplyTargetTest.actions.push({ kind: 'parent-escape' });
      }
    });
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.settingsApplyTargetTest.back());
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  assert.deepEqual(
    (await actions()).map((action) => action.kind),
    ['target', 'confirm'],
  );
  console.log(
    'PASS: stale target counts cannot confirm; busy apply consumes Escape and native Back',
  );

  await fresh();
  await page.getByRole('button', { name: 'Категории', exact: true }).click();
  const favoriteButtons = page
    .getByRole('group', { name: 'Категории избранного' })
    .getByRole('button');
  await favoriteButtons.first().waitFor();
  await favoriteButtons.first().click();
  await resolvePreview();
  assert.equal(await confirmButton().isEnabled(), true);
  await favoriteButtons.nth(1).click();
  assert.equal(await confirmButton().isDisabled(), true);
  await resolvePreview();
  await confirmButton().click();
  for (const button of await favoriteButtons.all()) assert.equal(await button.isDisabled(), true);
  console.log(
    'PASS: changing categories invalidates the preview and saving freezes every category',
  );

  await fresh();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await actions(), [{ kind: 'close' }]);
  await fresh();
  await page.evaluate(() => window.settingsApplyTargetTest.back());
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.deepEqual(await actions(), [{ kind: 'close' }]);
  console.log('PASS: idle Escape and native Back close only the target picker');

  for (const [name, width, height, theme] of [
    ['iphone-se', 320, 568, 'light'],
    ['iphone', 390, 844, 'light'],
    ['android-dark', 412, 915, 'dark'],
    ['desktop-dark', 1280, 900, 'dark'],
  ]) {
    await page.setViewportSize({ width, height });
    await fresh();
    await page.evaluate((theme) => (document.documentElement.dataset.maxTheme = theme), theme);
    await page.getByRole('button', { name: 'Категории', exact: true }).click();
    await resolvePreview();
    await page.screenshot({ path: join(screenshotDir, `${name}.png`), fullPage: true });
    assert.deepEqual(
      await page
        .locator('.settings-apply-target__panel')
        .evaluate((panel) =>
          [...panel.querySelectorAll('button, strong, li')]
            .filter((node) => node.scrollWidth > node.clientWidth + 1)
            .map((node) => node.textContent?.trim()),
        ),
      [],
      `${name} has overflowing controls`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    `PASS: mobile and desktop target controls fit both themes; screenshots: ${screenshotDir}`,
  );
} finally {
  await browser.close();
}
