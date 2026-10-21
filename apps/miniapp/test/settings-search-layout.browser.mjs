import assert from 'node:assert/strict';
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
const profiles = [
  ['iphone-light', devices['iPhone 15'], 'light', 'ios'],
  ['iphone-dark', devices['iPhone SE'], 'dark', 'ios'],
  ['android-light', devices['Pixel 7'], 'light', 'android'],
  ['android-dark', devices['Pixel 7'], 'dark', 'android'],
  ['desktop-light', { viewport: { width: 1280, height: 900 } }, 'light', 'desktop'],
];
const routes = [
  ['chat', 'chat/preview-chat/settings', 'Антидубль', '.settings-drilldown__panel--duplicates'],
  [
    'channel',
    'channel/preview-channel/settings',
    'Действие под публикацией',
    '.settings-drilldown__panel--signature',
  ],
];

async function settledBox(locator) {
  return locator.evaluate(async (element) => {
    await document.fonts.ready;
    let previous;
    let stable = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      await new Promise(requestAnimationFrame);
      const { x, y, width, height } = element.getBoundingClientRect();
      const current = { x, y, width, height };
      stable =
        previous &&
        Object.keys(current).every((key) => Math.abs(current[key] - previous[key]) < 0.1)
          ? stable + 1
          : 0;
      if (stable >= 5) return current;
      previous = current;
    }
    throw new Error('Settings geometry did not settle within 120 animation frames');
  });
}

async function assertOverviewLayout(page, name, entity) {
  await page.evaluate(() => window.scrollTo(0, 0));
  const header = await settledBox(page.locator('.managed-entity-workspace-header--settings'));
  const search = await settledBox(page.locator('.settings-overview-search-wrap'));
  assert.ok(
    search.y >= header.y + header.height - 0.5,
    `${name}/${entity} search overlaps the header: ${search.y} < ${header.y + header.height}`,
  );

  const pair =
    entity === 'chat' ? ['Ссылки', 'Ограничения'] : ['Быстрые кнопки', 'Комментарии в приложении'];
  const [left, right] = await Promise.all(
    pair.map((title) => settledBox(page.getByRole('button', { name: title, exact: true }))),
  );
  assert.ok(
    Math.abs(left.y - right.y) <= 0.5 && left.x + left.width <= right.x + 0.5,
    `${name}/${entity} ${pair.join(' / ')} must share a row in separate columns`,
  );
  assert.ok(
    Math.abs(left.width - right.width) <= 0.5,
    `${name}/${entity} module columns must have equal widths`,
  );
  const viewportWidth = await page.evaluate(() => innerWidth);
  for (const [index, box] of [left, right].entries()) {
    assert.ok(
      box.width >= 44 &&
        box.height >= 44 &&
        box.x >= -0.5 &&
        box.x + box.width <= viewportWidth + 0.5,
      `${name}/${entity} ${pair[index]} must remain a complete touch target within the viewport`,
    );
  }
}

async function assertOverviewSearch(page, name, entity, entry, enabled) {
  const containerId = `${entity}-settings-overview`;
  const entrySelector = entity === 'chat' ? '.settings-home-entry' : '.channel-settings-card';
  const overview = page.locator(`#${containerId}`);
  const entries = overview.locator(entrySelector);
  const visibleEntries = overview.locator(`${entrySelector}:visible`);
  const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
  const [alias, expectedTitle] =
    entity === 'chat'
      ? ['токсичность', 'Мат и оскорбления']
      : ['кастомные', 'Комментарии в приложении'];
  const expectedEntry = page.getByRole('button', { name: expectedTitle, exact: true });
  assert.ok(
    !(await expectedEntry.locator('.settings-section__title').innerText())
      .toLocaleLowerCase('ru-RU')
      .includes(alias),
    'The query must exercise a search alias rather than the visible module title',
  );
  assert.ok((await expectedEntry.getAttribute('data-settings-search')).includes(alias));
  await search.fill(alias);
  await page.waitForFunction(
    ({ containerId, entrySelector }) => {
      const entries = [...document.getElementById(containerId).querySelectorAll(entrySelector)];
      return entries.length > 0 && entries.filter((entry) => !entry.hidden).length === 1;
    },
    { containerId, entrySelector },
  );
  assert.equal(await visibleEntries.count(), 1, `${name}/${entity} alias search filters the board`);
  assert.equal(await expectedEntry.isVisible(), true);
  if (entity === 'chat') {
    assert.deepEqual(
      (await overview.locator('.settings-home-group-head:visible').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['Защита'],
      'Only the group containing the matching module remains visible',
    );
  }

  await search.fill('__нет_такой_настройки_9af13__');
  await page.getByText('Ничего не найдено', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await visibleEntries.count(), 0, 'An empty search must leave no visible modules');
  if (entity === 'chat') {
    assert.equal(await overview.locator('.settings-home-group-head:visible').count(), 0);
  }
  await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
  await page.waitForFunction(
    ({ containerId, entrySelector }) => {
      const entries = [...document.getElementById(containerId).querySelectorAll(entrySelector)];
      return entries.length > 0 && entries.every((entry) => !entry.hidden);
    },
    { containerId, entrySelector },
  );
  assert.equal(await search.inputValue(), '');
  assert.equal(await visibleEntries.count(), await entries.count(), 'Clear restores every module');
  assert.equal(await page.getByText('Ничего не найдено', { exact: true }).count(), 0);
  if (entity === 'chat') {
    assert.deepEqual(
      (await overview.locator('.settings-home-group-head:visible').allTextContents()).map((text) =>
        text.trim(),
      ),
      ['Защита', 'Контент'],
    );
  }
  assert.equal(
    await entry.getAttribute('data-enabled'),
    enabled,
    'Search must preserve the actual module state',
  );
  assert.equal(await entry.locator('.settings-section__state').isVisible(), true);
}

let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, device, colorScheme, platform] of profiles) {
    for (const [entity, routePath, title, panelSelector] of routes) {
      const context = await browser.newContext({ ...device, colorScheme });
      let releaseModule;
      const held = new Promise((resolve) => {
        releaseModule = resolve;
      });
      let requested = false;
      try {
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === new URL(base).origin
            ? route.continue()
            : route.abort(),
        );
        await context.route('**/src/components/ui/settings-overview-search.tsx*', async (route) => {
          requested = true;
          await held;
          await route.continue();
        });
        await installMaxBridgeShimInitScript(context, {}, { colorScheme, platform });
        await installNativeVisualModeInitScript(context);
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}${routePath}?preview=1`, { waitUntil: 'domcontentloaded' });
        const entry = page.getByRole('button', { name: title, exact: true });
        await entry.waitFor({ state: 'visible' });
        await applyNativeVisualMode(page, {
          safeTop: platform === 'ios' ? 44 : platform === 'android' ? 24 : 0,
          safeBottom: platform === 'ios' ? 34 : platform === 'android' ? 16 : 0,
        });
        assert.equal(requested, true, 'The actual lazy search module must be held');
        const placeholder = page.locator('.settings-overview-search-wrap[aria-hidden="true"]');
        assert.equal(await placeholder.count(), 1);
        await page.evaluate(() => window.scrollTo(0, 0));
        const initialHeaderBox = await settledBox(
          page.locator('.managed-entity-workspace-header--settings'),
        );
        const initialSearchBox = await settledBox(placeholder);
        assert.ok(
          initialSearchBox.y >= initialHeaderBox.y + initialHeaderBox.height - 0.5,
          `${name}/${entity} search fallback overlaps the native header`,
        );
        assert.equal(await page.getByRole('searchbox', { name: 'Найти настройку' }).count(), 0);
        assert.equal(await placeholder.evaluate((element) => element.inert), true);
        assert.equal(
          await placeholder.locator('input').evaluate((input) => {
            input.focus();
            return document.activeElement === input;
          }),
          false,
        );
        await page.keyboard.press('Tab');
        assert.equal(
          await placeholder.evaluate((element) => element.contains(document.activeElement)),
          false,
        );
        await page.evaluate(async () => {
          const { PREVIEW_REQUEST_HANDLERS } =
            await import('/app/src/lib/api/preview-transport.ts');
          const { PREVIEW_NOT_HANDLED } =
            await import('/app/src/lib/api/preview-transport-runtime.ts');
          window.__SEARCH_LAYOUT_WRITES__ = [];
          PREVIEW_REQUEST_HANDLERS.unshift(({ method }) => {
            if (method !== 'GET') window.__SEARCH_LAYOUT_WRITES__.push(method);
            return PREVIEW_NOT_HANDLED;
          });
        });
        await entry.scrollIntoViewIfNeeded();
        const before = await settledBox(entry);
        const placeholderBox = await placeholder.boundingBox();
        assert.ok(placeholderBox?.height > 0, 'Hidden fallback must occupy real space');
        if (platform === 'desktop') {
          await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
          await page.mouse.down();
        }
        releaseModule();
        const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
        await search.waitFor({ state: 'visible' });
        const after = await settledBox(entry);
        for (const key of ['x', 'y', 'width', 'height']) {
          assert.ok(
            Math.abs(before[key] - after[key]) <= 0.5,
            `${name}/${entity} ${key} shifted: ${before[key]} → ${after[key]}`,
          );
        }
        const readyBox = await page.locator('.settings-overview-search-wrap').boundingBox();
        assert.ok(
          Math.abs(readyBox.height - placeholderBox.height) <= 0.5,
          'Fallback and ready search heights must agree',
        );
        assert.equal(await placeholder.count(), 0);
        const enabled = await entry.getAttribute('data-enabled');
        assert.ok(enabled === 'true' || enabled === 'false');
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        const summaryId = await entry.locator('.settings-section__summary').getAttribute('id');
        assert.ok(
          summaryId &&
            ((await entry.getAttribute('aria-describedby')) ?? '').split(/\s+/).includes(summaryId),
          'The closed module keeps its summary connected as an accessible description',
        );
        assert.equal(
          await entry.locator('.settings-section__summary').evaluate((summary) => {
            const style = getComputedStyle(summary);
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              !summary.closest('[aria-hidden="true"]')
            );
          }),
          true,
        );
        assert.equal(await entry.locator('.settings-section__state').isVisible(), true);
        assert.equal(
          await entry.locator('.settings-section__summary').evaluate((summary) => {
            const bounds = summary.getBoundingClientRect();
            return bounds.width <= 1 && bounds.height <= 1 && summary.textContent.trim().length > 0;
          }),
          true,
          'Overview descriptions remain available to assistive technology without occupying a row',
        );
        assert.equal(
          await page
            .getByRole('button', { name: 'Опросы', exact: true })
            .getAttribute('data-enabled'),
          null,
          'Navigation-only tools must not claim an enabled or disabled state',
        );
        if (platform === 'desktop') await page.mouse.up();
        else await entry.tap();
        await page.locator(panelSelector).waitFor({ state: 'visible' });
        assert.equal(await page.locator('.settings-drilldown__panel:visible').count(), 1);
        const moduleSwitch =
          entity === 'chat'
            ? page.getByRole('checkbox', { name: 'Включить антидубль', exact: true })
            : page.locator('.channel-post-signature__activation input[type="checkbox"]');
        assert.equal(
          await moduleSwitch.isChecked(),
          enabled === 'true',
          'Overview indicator must match the actual module setting',
        );
        await page.locator(`${panelSelector} .settings-drilldown__close`).click();
        await page.locator(panelSelector).waitFor({ state: 'hidden' });
        await assertOverviewLayout(page, name, entity);
        await assertOverviewSearch(page, name, entity, entry, enabled);
        assert.deepEqual(await page.evaluate(() => window.__SEARCH_LAYOUT_WRITES__), []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(errors, []);
        console.log(
          `PASS ${name}/${entity}: delayed search keeps ${readyBox.height}px geometry, two-column modules, alias/empty/clear search, intended section and no writes`,
        );
      } finally {
        releaseModule();
        await context.close();
      }
    }
  }
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
