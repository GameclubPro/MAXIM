import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const screenshots = await mkdtemp(join(tmpdir(), 'maxim-speech-style-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/speech-style-test*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/app/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;
      window.__vite_plugin_react_preamble_installed__=true;
      await import('/app/test/fixtures/bot-speech-style-harness.tsx');
    </script></body></html>`,
    }),
  );
  let pending = [];
  let serverSettings;
  let pendingRefresh;
  let delayRefresh = false;
  await page.route('**/api/chats/*/settings', (route) => {
    if (delayRefresh) {
      pendingRefresh = route;
      return;
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(serverSettings) });
  });
  await page.route('**/api/chats/*/settings/speech-style', (route) => {
    pending.push(route);
  });
  const read = async () => JSON.parse(await page.getByTestId('state').textContent());
  const fresh = async (suffix = '') => {
    pending = [];
    pendingRefresh = undefined;
    delayRefresh = false;
    await page.goto(`${base}speech-style-test${suffix}`);
    await page.getByTestId('state').waitFor({ state: 'attached' });
    await page.waitForFunction(() =>
      Boolean(JSON.parse(document.querySelector('[data-testid="state"]').textContent).draft),
    );
    serverSettings = (await read()).draft;
  };
  const open = async () => {
    await page.getByRole('button', { name: 'Стиль речи', exact: true }).click();
    await page.getByRole('radio', { name: 'Коп', exact: true }).waitFor();
  };
  const panel = page.locator('.settings-drilldown__panel--speech');
  const startSave = async () => {
    await page.getByRole('radio', { name: 'Шут', exact: true }).click();
    const outgoing = page.waitForRequest('**/api/chats/*/settings/speech-style');
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const request = await outgoing;
    assert.equal(request.method(), 'PATCH');
    assert.deepEqual(request.postDataJSON(), { botSpeechStyle: 'IRONIC' });
    await panel.getByRole('button', { name: 'Сохраняем...', exact: true }).waitFor();
  };
  const reply = async (status = 200) => {
    assert.equal(pending.length, 1);
    serverSettings = {
      ...serverSettings,
      botSpeechStyle: 'IRONIC',
      settingsRevision: '2026-10-04T10:00:00.000Z',
    };
    await pending[0].fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(
        status === 200
          ? {
              botSpeechStyle: serverSettings.botSpeechStyle,
              settingsRevision: serverSettings.settingsRevision,
            }
          : { code: 'SAVE_FAILED' },
      ),
    });
  };
  const waitEvent = (event) =>
    page.waitForFunction(
      (value) =>
        JSON.parse(document.querySelector('[data-testid="state"]').textContent).events.includes(
          value,
        ),
      event,
    );

  await fresh();
  const initial = (await read()).draft;
  await open();
  assert.equal(
    await page.getByRole('radio', { name: 'Коп', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  assert.equal(await panel.getByRole('button', { name: 'Сохранить', exact: true }).count(), 0);
  await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
  assert.equal(await page.getByText('Не сохранять изменения?', { exact: true }).count(), 0);
  await open();
  await page.getByRole('radio', { name: 'Друг', exact: true }).click();
  await panel.getByRole('button', { name: 'Отмена', exact: true }).click();
  assert.deepEqual((await read()).draft, initial);
  assert.equal(pending.length, 0);
  await open();
  await page.getByRole('radio', { name: 'Друг', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  assert.deepEqual((await read()).draft, initial);
  assert.equal(pending.length, 0);
  console.log('PASS: null uses Police; cancel and confirmed Back never save');

  await page.getByRole('button', { name: 'Приветствие', exact: true }).click();
  const reset = page.getByRole('button', { name: 'Сбросить', exact: true });
  await reset.waitFor();
  await reset.click();
  assert.equal((await read()).draft.greetingBotMessageText, '');
  console.log('PASS: custom text equal to the built-in default remains explicitly resettable');

  await fresh();
  await page.getByLabel('Свой текст', { exact: true }).fill('  Локальный черновик {user}  ');
  const draft = (await read()).draft;
  serverSettings = {
    ...serverSettings,
    greetingBotMessageText: '  Текст другого администратора\r\n ',
    settingsRevision: '2026-10-04T09:30:00.000Z',
  };
  await open();
  await startSave();
  assert.equal(
    await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await panel.getByRole('button', { name: 'Отмена', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.settings-drilldown__backdrop').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByText('Не сохранять изменения?', { exact: true }).count(), 0);
  await reply();
  await waitEvent('saved');
  const saved = (await read()).draft;
  assert.equal(saved.greetingBotMessageText, serverSettings.greetingBotMessageText);
  assert.equal(saved.linkWarnMessageText, draft.linkWarnMessageText);
  assert.deepEqual(saved.botSpeechMedia, draft.botSpeechMedia);
  assert.equal(saved.settingsRevision, serverSettings.settingsRevision);
  assert.equal((await read()).dirty, true);
  console.log('PASS: style-only save refreshes remote custom text and preserves local draft/media');

  await fresh();
  await page.getByLabel('Свой текст', { exact: true }).fill('Локальная версия');
  serverSettings = { ...serverSettings, linkWarnMessageText: 'Другая версия' };
  await open();
  await startSave();
  await reply();
  await waitEvent('saved');
  assert.equal((await read()).draft.linkWarnMessageText, 'Локальная версия');
  assert.equal((await read()).draft.settingsRevision, '2026-10-04T09:00:00.000Z');
  assert.equal((await read()).dirty, true);
  console.log(
    'PASS: conflicting custom text keeps its old revision for explicit conflict resolution',
  );

  await fresh('?legacy=1');
  await open();
  await startSave();
  await reply();
  await waitEvent('saved');
  assert.equal((await read()).draft.settingsRevision, '2026-10-04T10:00:00.000Z');
  console.log('PASS: legacy cache without a revision adopts the complete refreshed snapshot');

  await fresh();
  await page.getByLabel('Свой текст', { exact: true }).fill('Локальный черновик');
  await open();
  await startSave();
  delayRefresh = true;
  const requestedRefresh = page.waitForRequest('**/api/chats/*/settings');
  await reply();
  await requestedRefresh;
  await page.getByTestId('cache-newer').evaluate((element) => element.click());
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="state"]').textContent).cached
        .settingsRevision === '2026-10-04T11:00:00.000Z',
  );
  await pendingRefresh.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(serverSettings),
  });
  await waitEvent('saved');
  assert.equal((await read()).cached.settingsRevision, '2026-10-04T11:00:00.000Z');
  assert.equal((await read()).draft.greetingBotMessageText, 'Новейший текст');
  assert.equal((await read()).draft.linkWarnMessageText, 'Локальный черновик');
  console.log('PASS: a late refresh cannot downgrade a newer cached settings version');

  await fresh();
  await open();
  const beforeFailure = (await read()).draft;
  await startSave();
  await reply(500);
  await waitEvent('error');
  assert.deepEqual((await read()).draft, beforeFailure);
  assert.equal(
    await page.getByRole('radio', { name: 'Шут', exact: true }).getAttribute('aria-checked'),
    'true',
  );
  assert.equal(
    await panel.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled(),
    true,
  );
  console.log('PASS: failed style save retains selection and all custom content');

  await fresh();
  await open();
  await startSave();
  await page.getByTestId('change-chat').evaluate((element) => element.click());
  await page.waitForFunction(
    () =>
      JSON.parse(document.querySelector('[data-testid="state"]').textContent).chatId === 'chat-b',
  );
  const otherChat = await read();
  await reply();
  await page.waitForTimeout(150);
  assert.deepEqual(await read(), otherChat);
  assert.deepEqual(errors, []);
  console.log('PASS: an old style response cannot change another chat');
  await page.close();

  for (const [name, device, colorScheme] of [
    ['iphone-light', devices['iPhone 15'], 'light'],
    ['iphone-dark', devices['iPhone 15'], 'dark'],
    ['android-light', devices['Pixel 7'], 'light'],
    ['android-dark', devices['Pixel 7'], 'dark'],
    ['iphone-se-light', devices['iPhone SE'], 'light'],
  ]) {
    const context = await browser.newContext({ ...device, colorScheme });
    await installMaxBridgeShimInitScript(
      context,
      { platform: name.startsWith('android') ? 'android' : 'ios' },
      { colorScheme },
    );
    await installNativeVisualModeInitScript(context);
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === new URL(base).origin
        ? route.continue()
        : route.abort(),
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}chat/preview-chat/settings?preview=1`);
    await applyNativeVisualMode(page, {
      safeTop: name.startsWith('iphone') ? 59 : 24,
      safeBottom: name.startsWith('iphone') ? 34 : 0,
    });
    await page.getByRole('button', { name: 'Стиль речи', exact: true }).click();
    const panel = page.locator('.settings-drilldown__panel--speech');
    await panel.waitFor();
    for (const style of ['Робот', 'Друг', 'Коп', 'Шут']) {
      await panel.getByRole('radio', { name: style, exact: true }).click();
      assert.equal(
        await panel.getByRole('radio', { name: style, exact: true }).getAttribute('aria-checked'),
        'true',
      );
    }
    await page.screenshot({ path: join(screenshots, `${name}-top.png`) });
    await panel.getByText('Ночной режим', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(screenshots, `${name}-bottom.png`) });
    assert.deepEqual(
      await panel.evaluate((element) =>
        [...element.querySelectorAll('p, .settings-speech-style-option__label')]
          .filter((node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2)
          .map((node) => node.textContent),
      ),
      [],
      `${name}: content overflow`,
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS: ${name} style choices, descriptions, preserved-custom note, examples and scrolling`,
    );
    await context.close();
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
