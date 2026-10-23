import assert from 'node:assert/strict';
import { chromium, devices, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const requestedBase = process.env.MINIAPP_TEST_BASE_URL;
const base = requestedBase ?? (await allocateMiniappBaseUrl('http://127.0.0.1/app/'));
const server = await ensureMiniappDevServer(base, { reuseServer: Boolean(requestedBase) });
const entrySelector = '[data-settings-navigation-entry="true"]';
const profiles = [
  {
    name: 'chromium-320-light',
    engine: chromium,
    width: 320,
    colorScheme: 'light',
    platform: 'android',
  },
  {
    name: 'chromium-412-dark',
    engine: chromium,
    width: 412,
    colorScheme: 'dark',
    platform: 'android',
  },
  { name: 'webkit-393-light', engine: webkit, width: 393, colorScheme: 'light', platform: 'ios' },
];
const families = [
  {
    name: 'chat',
    route: 'chat/preview-chat/settings?preview=1',
    root: '#chat-settings-overview',
    title: 'Мат и оскорбления',
    alias: 'токсичность',
  },
  {
    name: 'publisher-chat',
    route: 'publisher/chat/preview-chat?preview=1&profile=publisher',
    root: '.publisher-entity-modules-page__modules',
    title: 'Комментарии',
  },
  {
    name: 'channel',
    route: 'channel/preview-channel/settings?preview=1',
    root: '#channel-settings-overview',
    title: 'Комментарии в приложении',
    alias: 'кастомные',
  },
  {
    name: 'publisher-channel',
    route: 'publisher/channel/preview-channel?preview=1&profile=publisher',
    root: '.publisher-entity-modules-page__modules',
    title: 'Предложения',
  },
  {
    name: 'network-chat',
    route: 'networks?preview=1&networks=1&type=chat',
    root: '[data-network-settings-overview]',
    title: 'Мат и оскорбления',
    alias: 'токсичность',
    network: true,
  },
  {
    name: 'network-channel',
    route: 'networks?preview=1&networks=1&type=channel',
    root: '[data-network-settings-overview]',
    title: 'Комментарии в приложении',
    alias: 'кастомные',
    network: true,
  },
];

async function nativeBack(page) {
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
}

async function navigate(page, family, warm) {
  const target = new URL(family.route, base);
  if (!family.name.startsWith('publisher')) target.searchParams.set('networks', '1');
  const url = target.href;
  if (warm) {
    await page.evaluate((target) => {
      history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, url);
  } else {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  }
  if (family.network) {
    const first = page.locator('.network-summary-card').first();
    await first.waitFor({ state: 'visible' });
    await first.getByRole('button', { name: 'Настройки', exact: true }).click();
  }
  await page.locator(family.root).waitFor({ state: 'visible' });
  await page.locator(family.root).locator(entrySelector).first().waitFor({ state: 'visible' });
  await settleVisualFrame(page);
}

async function assertPlainEntries(page, root, label) {
  const entries = root.locator(
    '.settings-section__toggle, .publisher-module-entry, .publisher-comments-toggle',
  );
  assert.equal(
    await entries.count(),
    await root.locator(entrySelector).count(),
    `${label}: every real catalog entry carries the navigation contract`,
  );
  assert.ok(await entries.count(), `${label}: actual navigation rows must be present`);
  for (const entry of await entries.all()) {
    const details = await entry.evaluate((node) => {
      const title = node.querySelector(
        '.settings-section__title, .publisher-entity-module__copy > strong, :scope > strong',
      );
      const normalized = (value) => value?.replace(/\s+/gu, ' ').trim() ?? '';
      const range = document.createRange();
      range.selectNodeContents(title);
      const bounds = node.getBoundingClientRect();
      return {
        title: normalized(title.textContent),
        navigation: node.getAttribute('data-settings-navigation-entry'),
        content: normalized(node.textContent),
        label: node.getAttribute('aria-label'),
        describedBy: node.getAttribute('aria-describedby'),
        forbidden: node.querySelectorAll(
          '.settings-section__summary, .settings-section__status-chip, .settings-section__state, .settings-section__state-label, .settings-advertising-soon__badge, small, [role="status"]',
        ).length,
        decorative: [...node.querySelectorAll('svg')].every((icon) =>
          icon.closest('[aria-hidden="true"]'),
        ),
        nestedControls: node.querySelectorAll('button, a, input, [role="switch"]').length,
        titleFits: [...range.getClientRects()].every(
          (rect) =>
            rect.left >= bounds.left - 1 &&
            rect.right <= bounds.right + 1 &&
            rect.top >= bounds.top - 1 &&
            rect.bottom <= bounds.bottom + 1,
        ),
        visible: node.getClientRects().length > 0,
        width: bounds.width,
        height: bounds.height,
      };
    });
    assert.equal(
      details.navigation,
      'true',
      `${label}: the navigation contract covers every entry`,
    );
    assert.ok(details.title, `${label}: every entry has a real title`);
    assert.equal(
      details.content,
      details.title,
      `${label}/${details.title}: no extra or hidden text`,
    );
    assert.ok(
      details.label === null || details.label === details.title,
      `${label}/${details.title}: accessible name is the title`,
    );
    assert.equal(details.describedBy, null, `${label}/${details.title}: no hidden description`);
    assert.equal(
      details.forbidden,
      0,
      `${label}/${details.title}: remove state and summary markup`,
    );
    assert.equal(details.decorative, true, `${label}/${details.title}: icons are decorative`);
    assert.equal(details.nestedControls, 0, `${label}/${details.title}: one whole-row action`);
    if (!details.visible) continue;
    assert.equal(details.titleFits, true, `${label}/${details.title}: title remains complete`);
    assert.ok(
      details.width >= 44 && details.height >= 44,
      `${label}/${details.title}: complete touch target`,
    );
  }
  const misplacedGroups = await root.locator('.settings-overview-group').evaluateAll((groups) =>
    groups.flatMap((group) => {
      if (!group.getClientRects().length) return [];
      const heading = group.querySelector('.settings-home-group-head');
      const entries = group.querySelector('.settings-overview-group__entries');
      if (!heading?.getClientRects().length || !entries?.getClientRects().length) return [];
      const head = heading.getBoundingClientRect();
      const rows = entries.getBoundingClientRect();
      return head.bottom > rows.top + 1 ? [heading.textContent.trim()] : [];
    }),
  );
  assert.deepEqual(misplacedGroups, [], `${label}: group headings must precede their rows`);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${label}: no horizontal overflow`,
  );
}

async function assertOpenBack(page, family, root, label) {
  const entry = root.locator(entrySelector).filter({ hasText: family.title });
  assert.equal(await entry.count(), 1);
  await entry.scrollIntoViewIfNeeded();
  await settleVisualFrame(page);
  const beforeScroll = await page.evaluate(() => window.scrollY);
  const box = await entry.boundingBox();
  assert.equal(
    await entry.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + bounds.width / 2,
        bounds.top + bounds.height / 2,
      );
      return hit === node || node.contains(hit);
    }),
    true,
    `${label}: row accepts pointer input`,
  );
  await entry.click({ position: { x: Math.min(20, box.width / 2), y: box.height / 2 } });
  const panel = page.getByRole('dialog', { name: family.title, exact: true });
  await panel.waitFor({ state: 'visible' });
  assert.ok(
    await panel.locator('input, button, [role="switch"], [role="radio"]').count(),
    `${label}: the editor retains actual controls`,
  );
  await nativeBack(page);
  await panel.waitFor({ state: 'hidden' });
  await root.waitFor({ state: 'visible' });
  await settleVisualFrame(page);
  assert.equal(
    await entry.evaluate((node) => document.activeElement === node),
    true,
    `${label}: native Back restores the entry focus`,
  );
  assert.ok(
    Math.abs((await page.evaluate(() => window.scrollY)) - beforeScroll) <= 2,
    `${label}: native Back restores scroll position`,
  );
}

async function assertSearch(page, family, root, label) {
  const search = page.getByRole('searchbox', { name: 'Найти настройку', exact: true });
  await search.fill(family.alias);
  await page.waitForFunction(
    ({ rootSelector, selector }) =>
      [...document.querySelector(rootSelector).querySelectorAll(selector)].filter(
        (entry) => entry.getClientRects().length,
      ).length === 1,
    { rootSelector: family.root, selector: entrySelector },
  );
  await assertPlainEntries(page, root, `${label}/filtered`);
  await assertOpenBack(page, family, root, label);
  assert.equal(
    await search.inputValue(),
    family.alias,
    `${label}: opening a module preserves the search query`,
  );
  await search.fill('__no_settings_match_9af13__');
  await page.getByText('Ничего не найдено', { exact: true }).waitFor();
  assert.equal(await root.locator(`${entrySelector}:visible`).count(), 0);
  await page.getByRole('button', { name: 'Сбросить поиск', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Найти настройку"]').value === '',
  );
  assert.equal(
    await search.evaluate((node) => document.activeElement === node),
    true,
    `${label}: empty-search reset restores input focus`,
  );
  await search.fill(family.alias);
  await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
  assert.equal(await search.inputValue(), '');
  assert.equal(
    await search.evaluate((node) => document.activeElement === node),
    true,
    `${label}: clear restores input focus`,
  );
}

async function assertForeignRouteCssIsScoped(page, root, publisher, label) {
  const entry = root.locator(entrySelector).first();
  const readAppearance = () =>
    entry.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const title = node.querySelector(
        '.settings-section__title, .publisher-entity-module__copy > strong, :scope > strong',
      );
      const titleStyle = getComputedStyle(title);
      return {
        width: bounds.width,
        height: bounds.height,
        color: style.color,
        background: style.backgroundColor,
        border: style.borderColor,
        radius: style.borderRadius,
        font: titleStyle.fontFamily,
        size: titleStyle.fontSize,
        weight: titleStyle.fontWeight,
      };
    });
  const before = await readAppearance();
  await page.evaluate(async (isPublisher) => {
    if (isPublisher) {
      await import('/app/src/pages/channel-settings-page.tsx');
      await import('/app/src/pages/settings/chat-settings-workspace.tsx');
    } else {
      await import('/app/src/pages/publisher-entity-modules-page.tsx');
    }
  }, publisher);
  await settleVisualFrame(page);
  assert.deepEqual(
    await readAppearance(),
    before,
    `${label}: another profile's lazy CSS does not restyle the current catalog`,
  );
}

async function assertResponsiveDraftContinuity(page, profile) {
  const family = families.find((entry) => entry.name === 'chat');
  await navigate(page, family, true);
  await page.getByRole('button', { name: family.title, exact: true }).click();
  const panel = page.getByRole('dialog', { name: family.title, exact: true });
  await panel.waitFor({ state: 'visible' });
  const sensitivity = panel.getByRole('radiogroup', {
    name: 'Чувствительность фильтра мата и оскорблений',
    exact: true,
  });
  const radios = sensitivity.getByRole('radio');
  const originalValue = await radios.count();
  assert.ok(originalValue > 0, 'The real editor exposes its sensitivity controls');
  const original = sensitivity.getByRole('radio', { checked: true });
  const originalName = await original.textContent();
  const alternate = sensitivity.getByRole('radio', { name: 'Строго', exact: true });
  await alternate.click();
  await alternate.evaluate((node) => {
    node.__overviewDraftIdentity = true;
  });
  for (const width of [599, 601, 599, profile.width]) {
    await page.setViewportSize({ width, height: 740 });
    await settleVisualFrame(page);
    assert.equal(await panel.isVisible(), true, 'Responsive grouping keeps the open editor');
    assert.equal(
      await alternate.getAttribute('aria-checked'),
      'true',
      'Responsive grouping keeps unsaved values',
    );
    assert.equal(
      await alternate.evaluate((node) => node.__overviewDraftIdentity === true),
      true,
      'The real input is not remounted at the mobile boundary',
    );
  }
  await sensitivity.getByRole('radio', { name: originalName.trim(), exact: true }).click();
  await nativeBack(page);
  await panel.waitFor({ state: 'hidden' });
}

try {
  for (const profile of profiles) {
    const browser = await profile.engine.launch(
      captureBrowserLaunchOptions(profile.engine === webkit ? 'webkit' : 'chromium', base),
    );
    const context = await browser.newContext({
      ...devices[profile.platform === 'ios' ? 'iPhone SE' : 'Pixel 7'],
      viewport: { width: profile.width, height: 740 },
      screen: { width: profile.width, height: 804 },
      colorScheme: profile.colorScheme,
      locale: 'ru-RU',
      reducedMotion: 'reduce',
    });
    try {
      await context.route('**/*', (route) =>
        new URL(route.request().url()).origin === new URL(base).origin
          ? route.continue()
          : route.abort(),
      );
      await installMaxBridgeShimInitScript(
        context,
        {},
        { colorScheme: profile.colorScheme, platform: profile.platform },
      );
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const publisher of [false, true]) {
        const scopedFamilies = families.filter(
          (family) => family.name.startsWith('publisher') === publisher,
        );
        for (const [index, family] of scopedFamilies.entries()) {
          await navigate(page, family, index > 0);
          await applyNativeVisualMode(page, {
            safeTop: profile.platform === 'ios' ? 44 : 24,
            safeBottom: profile.platform === 'ios' ? 34 : 16,
          });
          const root = page.locator(family.root);
          const label = `${profile.name}/${family.name}`;
          await assertPlainEntries(page, root, label);
          if (index === 0) await assertForeignRouteCssIsScoped(page, root, publisher, label);
          if (family.alias) await assertSearch(page, family, root, label);
          else await assertOpenBack(page, family, root, label);
          await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
          await settleVisualFrame(page);
          await assertPlainEntries(page, root, `${label}/200%`);
          await page.evaluate(() => document.documentElement.style.removeProperty('font-size'));
          await settleVisualFrame(page);
          console.log(
            `PASS ${label}: title-only DOM, whole-row navigation, native Back/focus/scroll, ${family.alias ? 'alias/empty/clear search, ' : ''}200% text and ${index > 0 ? 'cross-route' : 'cold/foreign-profile'} CSS`,
          );
        }
        if (!publisher) {
          await assertResponsiveDraftContinuity(page, profile);
          console.log(
            `PASS ${profile.name}: 599→601→599 keeps the open editor, input identity and unsaved value`,
          );
        }
      }
      assert.deepEqual(errors, [], `${profile.name}: no page errors`);
    } finally {
      await context.close();
      await browser.close();
    }
  }
} finally {
  await stopChildProcess(server);
}
