import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import { resolveCaptureDevice } from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Local preview required');
for (const device of ['iphone-se', 'android']) {
  const capture = resolveCaptureDevice(presets[device]);
  const browser = await { chromium, webkit }[capture.browserName].launch({
    env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
  });
  try {
    const context = await browser.newContext({
      ...capture.contextOptions,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/time-field-keyboard-test?**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module">
          import RefreshRuntime from '/app/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window);
          window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true;
          await import('/app/test/fixtures/time-field-keyboard-harness.tsx');</script></body></html>`,
      }),
    );

    const open = async (step, value = '12:00') => {
      const url = new URL('time-field-keyboard-test', base);
      url.searchParams.set('step', String(step));
      url.searchParams.set('value', value);
      await page.goto(url.href);
      await page.getByRole('button', { name: `Время: ${value}`, exact: true }).click();
      await page.getByRole('dialog').waitFor();
      const minuteList = page.getByRole('listbox', { name: 'Минуты', exact: true });
      await minuteList.getByRole('option', { selected: true }).focus();
      return minuteList;
    };

    const checkSelection = async (list, minute) => {
      const expected = String(minute).padStart(2, '0');
      await page.waitForFunction(
        (expected) => document.activeElement?.textContent === expected,
        expected,
      );
      assert.equal(await list.getByRole('option', { selected: true }).textContent(), expected);
      assert.equal(await list.locator('[tabindex="0"]').count(), 1);
      assert.equal(await page.getByLabel('Сохранённое время').textContent(), '12:00');
    };

    let minutes = await open(30);
    for (const [key, value] of [
      ['ArrowDown', 30],
      ['ArrowDown', 0],
      ['ArrowUp', 30],
      ['Home', 0],
      ['End', 30],
      ['PageUp', 0],
      ['PageDown', 30],
      ['ArrowLeft', 0],
      ['ArrowRight', 30],
    ]) {
      await page.keyboard.press(key);
      await checkSelection(minutes, value);
    }
    await page.getByRole('button', { name: 'Применить', exact: true }).click();
    assert.equal(await page.getByLabel('Сохранённое время').textContent(), '12:30');

    minutes = await open(15);
    for (const [key, value] of [
      ['End', 45],
      ['ArrowRight', 0],
      ['ArrowDown', 15],
      ['PageDown', 0],
    ]) {
      await page.keyboard.press(key);
      await checkSelection(minutes, value);
    }

    minutes = await open(1);
    const hours = page.getByRole('listbox', { name: 'Часы', exact: true });
    await hours.getByRole('option', { selected: true }).focus();
    for (const [key, value] of [
      ['ArrowDown', '13'],
      ['PageDown', '19'],
      ['End', '23'],
      ['ArrowRight', '00'],
      ['PageUp', '18'],
      ['Home', '00'],
    ]) {
      await page.keyboard.press(key);
      await page.waitForFunction(
        (expected) => document.activeElement?.textContent === expected,
        value,
      );
      assert.equal(await hours.getByRole('option', { selected: true }).textContent(), value);
      assert.equal(await hours.locator('[tabindex="0"]').count(), 1);
    }
    await minutes.getByRole('option', { selected: true }).focus();
    for (const [key, value] of [
      ['ArrowDown', 1],
      ['PageDown', 11],
      ['End', 59],
      ['ArrowRight', 0],
    ]) {
      await page.keyboard.press(key);
      await checkSelection(minutes, value);
    }

    minutes = await open(60);
    for (const key of ['ArrowDown', 'ArrowUp', 'End', 'PageDown', 'PageUp']) {
      await page.keyboard.press(key);
      await checkSelection(minutes, 0);
    }

    minutes = await open(30, '12:17');
    assert.equal(await minutes.getByRole('option', { selected: true }).textContent(), '17');
    assert.deepEqual(await minutes.getByRole('option').allTextContents(), ['00', '17', '30']);
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.textContent === '30');
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.activeElement?.textContent === '17');
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    assert.equal(await page.getByLabel('Сохранённое время').textContent(), '12:17');
    assert.deepEqual(errors, []);
    console.log(
      `PASS time keyboard ${device}: steps 1/15/30/60, arrows, Home/End, PageUp/Down, wrap, off-step saved value, apply/cancel`,
    );
    await context.close();
  } finally {
    await browser.close();
  }
}
