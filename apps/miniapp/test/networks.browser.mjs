import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { clickSettingsOverviewEntry } from './settings-overview-browser-helpers.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import {
  captureBrowserLaunchOptions,
  setPhoneKeyboard,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('Networks browser checks require a local preview server');
const output = mkdtempSync(join(tmpdir(), 'maxim-networks-'));

async function fits(page, name) {
  await settleVisualFrame(page);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
    `${name}: horizontal page overflow`,
  );
  const clipped = await page
    .locator(
      '.networks-page, .network-composition-sheet, [data-network-settings-overview], .network-settings-editor',
    )
    .evaluateAll((roots) =>
      roots.flatMap((root) =>
        [...root.querySelectorAll('button, input, select, h1, h2, h3')]
          .filter((node) => {
            const style = getComputedStyle(node);
            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              node.clientWidth > 0 &&
              node.tagName !== 'SELECT' &&
              node.scrollWidth > node.clientWidth + 2
            );
          })
          .map((node) => node.textContent?.trim() || node.getAttribute('aria-label')),
      ),
    );
  assert.deepEqual(clipped, [], `${name}: clipped controls`);
  const outsideSelects = await page
    .locator('.network-settings-editor select')
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => {
          const bounds = node.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < -1 || bounds.right > innerWidth + 1);
        })
        .map((node) => node.getAttribute('aria-label') || node.labels?.[0]?.textContent),
    );
  assert.deepEqual(outsideSelects, [], `${name}: select outside viewport`);
}

async function observe(page) {
  await page.evaluate(async () => {
    const findModule = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`))?.name;
    const { PREVIEW_REQUEST_HANDLERS } = await import(findModule('preview-transport.ts'));
    const { PREVIEW_NOT_HANDLED } = await import(findModule('preview-transport-runtime.ts'));
    const { handleNetworksPreviewRequest } = await import(
      findModule('preview-transport-networks.ts')
    );
    window.__networkRequests = [];
    window.__networkLostComposition = false;
    PREVIEW_REQUEST_HANDLERS.unshift(async (context) => {
      const { url, method, init } = context;
      window.__networkRequests.push({
        path: url.pathname,
        method,
        query: Object.fromEntries(url.searchParams),
        body: init.body ? JSON.parse(init.body) : null,
      });
      if (
        window.__networkLostComposition &&
        method === 'PUT' &&
        url.pathname.endsWith('/composition')
      ) {
        window.__networkLostComposition = false;
        await handleNetworksPreviewRequest(context);
        throw new Error('Preview response lost after committed composition');
      }
      return PREVIEW_NOT_HANDLED;
    });
  });
}

async function back(page) {
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
}

const sectionFieldLabels = {
  links: ['Режим проверки ссылок', 'Срок ограничения, ч', 'Период учёта нарушений, ч'],
  greeting: [
    'Приветствовать новых участников',
    'Добавить кнопку правил',
    'Удалять приветствие бота',
    'Удалять через',
  ],
};

async function tileAppearance(root) {
  return root.locator('.settings-section__toggle').evaluateAll((buttons) =>
    buttons.map((button) => {
      const card = button.closest('.settings-home-entry');
      const badge = button.querySelector('.settings-section__icon-badge');
      const title = button.querySelector('.settings-section__title');
      const style = getComputedStyle(title);
      return {
        title: title.textContent.trim(),
        card: [...card.classList].sort(),
        badge: [...badge.classList].sort(),
        icon: badge.innerHTML,
        titleStyle: {
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          color: style.color,
        },
      };
    }),
  );
}

async function sectionAppearance(panel, section) {
  return panel.evaluate((root, labels) => {
    const appearance = (node) => {
      if (!node) throw new Error('Missing settings presentation node');
      const style = getComputedStyle(node);
      return Object.fromEntries(
        [
          'display',
          'boxSizing',
          'gap',
          'minHeight',
          'paddingTop',
          'paddingRight',
          'paddingBottom',
          'paddingLeft',
          'borderTopWidth',
          'borderTopStyle',
          'borderTopColor',
          'borderRadius',
          'backgroundColor',
          'color',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'lineHeight',
        ].map((key) => [key, style[key]]),
      );
    };
    const fields = labels.map((label) => {
      const control = [...root.querySelectorAll('input, select, textarea')].find(
        (node) => node.getAttribute('aria-label') === label,
      );
      if (!control) throw new Error('Missing shared field: ' + label);
      const wrapper = control.closest('.network-settings-field');
      return {
        label,
        tag: control.tagName,
        type: control.getAttribute('type'),
        options:
          control.tagName === 'SELECT'
            ? [...control.options]
                .filter((option) => option.value !== '')
                .map((option) => ({ value: option.value, label: option.textContent.trim() }))
            : null,
        control: appearance(control),
        wrapper: appearance(wrapper),
        labelStyle: appearance(wrapper.querySelector('.network-settings-field__label')),
      };
    });
    return {
      title: root.querySelector('.settings-drilldown__title').textContent.trim(),
      classes: [...root.classList].filter((name) => name !== 'network-settings-editor').sort(),
      icon: root.querySelector('.settings-drilldown__symbol')?.innerHTML ?? null,
      titleStyle: appearance(root.querySelector('.settings-drilldown__title')),
      groups: [...root.querySelectorAll('.shared-chat-settings-group')].map((group) => ({
        title: group.querySelector('.settings-subsection-title').textContent.trim(),
        style: appearance(group),
      })),
      fields,
      hasBody: Boolean(root.querySelector('.settings-drilldown__body')),
    };
  }, sectionFieldLabels[section]);
}

async function singleSettingsAppearance(context, profile, errors) {
  const single = await context.newPage();
  single.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  try {
    await single.goto(new URL('chat/preview-chat/settings?preview=1', base).href);
    await single.locator('.settings-sections--chat-home').waitFor();
    await single.getByRole('searchbox', { name: 'Найти настройку', exact: true }).waitFor();
    await applyNativeVisualMode(single, { safeTop: 0, safeBottom: profile.safeBottom });
    await settleVisualFrame(single);
    const tiles = await tileAppearance(single.locator('#chat-settings-overview'));
    const sections = {};
    for (const [section, title] of [
      ['links', 'Ссылки'],
      ['greeting', 'Приветствие'],
    ]) {
      await clickSettingsOverviewEntry(single, title);
      const panel = single.getByRole('dialog', { name: title, exact: true });
      await panel.getByLabel(sectionFieldLabels[section][0], { exact: true }).waitFor();
      await settleVisualFrame(single);
      sections[section] = await sectionAppearance(panel, section);
      await back(single);
      await panel.waitFor({ state: 'hidden' });
    }
    return { tiles, sections };
  } finally {
    await single.close();
  }
}

async function readRequests(page) {
  return page.evaluate(() =>
    window.__networkRequests.filter((row) => row.method === 'POST' && row.path.endsWith('/read')),
  );
}

async function settingsHub(page, { scope, readCount = 0, single } = {}) {
  const hub = page.locator('[data-network-settings-overview]');
  await hub.waitFor();
  await page.locator('.network-settings-editor').waitFor({ state: 'hidden' });
  await hub.getByRole('searchbox', { name: 'Найти настройку', exact: true }).waitFor();
  await settleVisualFrame(page);
  const url = new URL(page.url());
  assert.match(url.pathname, /\/networks\/chat\/settings\/?$/u, 'configure opens section hub');
  if (scope) assert.equal(url.searchParams.get('scope'), scope, 'hub keeps target scope');
  assert.equal(await hub.locator('select').count(), 0, 'section hub has no native section select');
  assert.equal(
    (await readRequests(page)).length,
    readCount,
    'unopened sections do not read settings',
  );
  if (single) {
    assert.equal(
      await hub.locator('.settings-sections--chat-home .settings-sections-shell').count(),
      1,
    );
    const tiles = await tileAppearance(hub);
    assert.ok(tiles.length > 0, 'hub has actual settings cards');
    for (const tile of tiles) {
      const original = single.tiles.find((entry) => entry.title === tile.title);
      assert.ok(original, 'group tile exists in actual single settings: ' + tile.title);
      assert.deepEqual(tile, original, 'actual single/group card parity: ' + tile.title);
    }
  }
  return url.searchParams.get('scope');
}

async function openSettingsSection(page, section, single) {
  const title = section === 'links' ? 'Ссылки' : 'Приветствие';
  await clickSettingsOverviewEntry(page, title);
  const panel = page.locator('.network-settings-editor');
  await panel.getByLabel(sectionFieldLabels[section][0], { exact: true }).waitFor();
  await settleVisualFrame(page);
  assert.equal(await panel.getAttribute('role'), 'dialog');
  assert.equal(
    await panel.locator('.settings-drilldown__footer-actions').count(),
    1,
    'group editor keeps its preview/apply footer',
  );
  assert.equal(await panel.locator('.settings-drilldown__title').innerText(), title);
  if (single) {
    assert.deepEqual(
      await sectionAppearance(panel, section),
      single.sections[section],
      'actual single/group fields and computed presentation: ' + title,
    );
  }
  return panel;
}

for (const profile of [
  {
    name: 'iphone-se-dark',
    engine: webkit,
    width: 320,
    height: 504,
    theme: 'dark',
    platform: 'ios',
    safeBottom: 0,
  },
  {
    name: 'iphone-light',
    engine: webkit,
    width: 390,
    height: 741,
    theme: 'light',
    platform: 'ios',
    safeBottom: 34,
  },
  {
    name: 'android-light',
    engine: chromium,
    width: 393,
    height: 747,
    theme: 'light',
    platform: 'android',
    safeBottom: 0,
  },
].filter(
  (profile) =>
    !process.env.MINIAPP_TEST_PROFILE || profile.name === process.env.MINIAPP_TEST_PROFILE,
)) {
  const browser = await profile.engine.launch(
    captureBrowserLaunchOptions(profile.engine.name(), base.href),
  );
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    colorScheme: profile.theme,
    reducedMotion: 'reduce',
    isMobile: true,
    hasTouch: true,
  });
  await installNativeVisualModeInitScript(context);
  await installMaxBridgeShimInitScript(
    context,
    { platform: profile.platform },
    { colorScheme: profile.theme },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('requestfailed', (request) =>
    console.error('REQUEST FAILED', request.url(), request.failure()?.errorText),
  );
  const open = async (path, selector, extras = {}) => {
    const url = new URL(path, base);
    url.searchParams.set('preview', '1');
    for (const [key, value] of Object.entries(extras)) url.searchParams.set(key, value);
    await page.goto(url.href);
    await page.locator(selector).first().waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: profile.safeBottom });
  };
  try {
    await open('', '.chat-card');
    assert.equal(
      await page.locator('.bottom-nav__item').count(),
      3,
      'gated Major keeps three navigation items',
    );
    assert.equal(await page.getByRole('link', { name: 'Сетки', exact: true }).count(), 0);
    const single = await singleSettingsAppearance(context, profile, errors);
    await open('networks?type=chat', '.network-summary-card', { networks: '1' });
    await observe(page);
    assert.equal(await page.locator('.bottom-nav__item').count(), 4);
    await fits(page, `${profile.name} catalogue`);
    await page.screenshot({
      path: join(output, `${profile.name}-catalogue.png`),
      animations: 'disabled',
    });

    await page.locator('.network-summary-card__open').first().click();
    await page.getByRole('radio', { name: /^Сообщества/u }).click();
    await page.locator('[data-network-entity-id]').first().waitFor();
    assert.equal(await page.locator('[data-network-entity-id]').count(), 50);
    const configure = page.getByRole('button', { name: /^Настроить/u });
    assert.equal(await configure.isDisabled(), true, 'empty selection must not mean everyone');
    await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).check();
    assert.equal(await configure.isEnabled(), true);
    await configure.click();
    const categoryScope = await settingsHub(page, { single });
    assert.equal(await page.locator('.bottom-nav').count(), 0);
    await fits(page, `${profile.name} settings hub`);
    await page.screenshot({
      path: join(output, `${profile.name}-settings-hub.png`),
      animations: 'disabled',
    });
    await openSettingsSection(page, 'links', single);
    const reads = await readRequests(page);
    assert.ok(reads.length > 1, 'group settings must read beyond the first recipient page');
    assert.ok(
      reads.every((row) => row.body.target.mode === 'category'),
      'whole category stays server resolved',
    );
    assert.ok(reads.every((row) => !('source' in row.body) && !('sourceId' in row.body)));
    assert.ok(
      Number(
        (
          await page.locator('.network-settings-editor .settings-drilldown__summary').innerText()
        ).match(/Выбрано: (\d+)/u)?.[1],
      ) > 50,
    );
    const writesBefore = await page.evaluate(
      () =>
        window.__networkRequests.filter(
          (row) => row.method !== 'GET' && !row.path.endsWith('/read'),
        ).length,
    );
    await back(page);
    await settingsHub(page, { scope: categoryScope, readCount: reads.length });
    await back(page);
    await page.locator('[data-network-entity-id]').first().waitFor();
    assert.equal(
      await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).isChecked(),
      true,
      'Back keeps category selection',
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__networkRequests.filter(
            (row) => row.method !== 'GET' && !row.path.endsWith('/read'),
          ).length,
      ),
      writesBefore,
      'opening and closing settings cannot save changes',
    );

    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
    await page.locator('[data-network-entity-id]').nth(50).waitFor();
    await page.locator('[data-network-entity-id]').last().scrollIntoViewIfNeeded();
    await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).check();
    await configure.scrollIntoViewIfNeeded();
    await settleVisualFrame(page);
    const position = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-network-entity-id]')].find(
        (node) => node.getBoundingClientRect().bottom > 0,
      );
      return {
        scrollY,
        id: row?.getAttribute('data-network-entity-id'),
        offset: row?.getBoundingClientRect().top,
      };
    });
    assert.ok(position.id, 'list position has an actual row anchor');
    const readCountBeforeReopen = (await readRequests(page)).length;
    await configure.click();
    const restoredScope = await settingsHub(page, { readCount: readCountBeforeReopen });
    await openSettingsSection(page, 'links');
    const readCountAfterReopen = (await readRequests(page)).length;
    await back(page);
    await settingsHub(page, { scope: restoredScope, readCount: readCountAfterReopen });
    await back(page);
    const restoredAnchor = page.locator(`[data-network-entity-id="${position.id}"]`);
    await restoredAnchor.waitFor();
    await page.waitForFunction(({ id, offset }) => {
      const row = [...document.querySelectorAll('[data-network-entity-id]')].find(
        (node) => node.getAttribute('data-network-entity-id') === id,
      );
      return row && Math.abs(row.getBoundingClientRect().top - offset) <= 2;
    }, position);
    assert.ok(
      (await page.locator('[data-network-entity-id]').count()) > 50,
      'Back restores loaded pages',
    );
    assert.equal(
      await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).isChecked(),
      true,
      'Back restores selected category',
    );
    assert.ok(
      Math.abs((await page.evaluate(() => scrollY)) - position.scrollY) <= 2,
      'Back restores list scroll position',
    );

    await page.getByRole('button', { name: 'Изменить состав', exact: true }).click();
    const sheet = page.locator('.network-composition-sheet');
    await sheet.waitFor();
    const firstAssignment = sheet.getByRole('combobox').first();
    const desiredAssignment =
      (await firstAssignment.inputValue()) === 'watch' ? 'important' : 'watch';
    await firstAssignment.selectOption(desiredAssignment);
    await back(page);
    await page.getByRole('dialog', { name: 'Сбросить изменения состава?', exact: true }).waitFor();
    await back(page);
    await page
      .getByRole('dialog', { name: 'Сбросить изменения состава?', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(await sheet.isVisible(), true, 'Native Back closes confirmation before editor');
    assert.equal(
      await firstAssignment.inputValue(),
      desiredAssignment,
      'cancelled discard preserves draft',
    );
    await fits(page, `${profile.name} composition`);
    await page.screenshot({
      path: join(output, `${profile.name}-composition.png`),
      animations: 'disabled',
    });
    await sheet.getByRole('searchbox').focus();
    await setPhoneKeyboard(page, { mode: 'resize', height: 230 });
    await fits(page, `${profile.name} composition keyboard`);
    const saveBox = await sheet
      .getByRole('button', { name: 'Сохранить состав', exact: true })
      .boundingBox();
    assert.ok(
      saveBox && saveBox.y + saveBox.height <= page.viewportSize().height + 1,
      'composition save stays above keyboard',
    );
    await setPhoneKeyboard(page, { mode: 'resize', open: false });
    await page.evaluate(() => {
      window.__networkLostComposition = true;
    });
    await sheet.getByRole('button', { name: 'Сохранить состав', exact: true }).click();
    await sheet.getByText('Нужно согласовать состав', { exact: true }).waitFor();
    assert.equal(await sheet.isVisible(), true, 'lost write response preserves composition draft');
    await sheet.getByRole('button', { name: 'Прочитать актуальный состав', exact: true }).click();
    await sheet.getByRole('button', { name: 'Принять актуальную основу', exact: true }).click();
    assert.equal(
      await sheet.getByRole('button', { name: 'Сохранить состав', exact: true }).isDisabled(),
      true,
      'already committed desired assignment needs no replay',
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.__networkRequests.filter(
            (row) => row.method === 'PUT' && row.path.endsWith('/composition'),
          ).length,
      ),
      1,
    );
    await back(page);
    await sheet.waitFor({ state: 'hidden' });
    await back(page);
    await page.locator('.network-summary-card').first().waitFor();
    await page.getByRole('radio', { name: 'Каналы', exact: true }).click();
    await page.getByText('Подписчики', { exact: true }).first().waitFor();
    assert.match(await page.locator('.network-summary-card').first().innerText(), /Подписчики/u);
    await fits(page, `${profile.name} channel catalogue`);

    const openSelectedSettings = async (scenario) => {
      await open(
        'networks?type=chat&category=important&tab=communities',
        '[data-network-entity-id]',
        {
          networks: '1',
          networksScenario: scenario,
        },
      );
      await observe(page);
      await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).uncheck();
      await page.locator('[data-network-entity-id="preview-network-chat-0001"] input').check();
      await page.locator('[data-network-entity-id="preview-network-chat-0002"] input').check();
      await page.getByRole('button', { name: /^Настроить/u }).click();
      const scope = await settingsHub(page);
      await openSettingsSection(page, 'links');
      return scope;
    };
    const selectedScope = await openSelectedSettings('uncertain');
    const policy = page
      .locator('.network-settings-editor')
      .getByLabel('Режим проверки ссылок', { exact: true });
    assert.equal(await policy.inputValue(), '', 'different settings remain mixed');
    await policy.focus();
    await policy.blur();
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isDisabled(),
      true,
      'focus cannot create a draft',
    );
    await policy.selectOption('ALERT_ONLY');
    const leaveDialog = page.getByRole('dialog', { name: 'Выйти без сохранения?', exact: true });
    await back(page);
    await leaveDialog.waitFor();
    await back(page);
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(await policy.inputValue(), 'ALERT_ONLY', 'cancel leaving keeps draft');
    await back(page);
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
    await settingsHub(page, { scope: selectedScope, readCount: (await readRequests(page)).length });
    await openSettingsSection(page, 'greeting', single);
    assert.equal(
      await page.getByLabel('Режим проверки ссылок', { exact: true }).count(),
      0,
      'new section does not retain old fields',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isDisabled(),
      true,
      'discarded Links draft is not carried to Greeting',
    );
    await fits(page, `${profile.name} greeting settings`);
    await page.screenshot({
      path: join(output, `${profile.name}-greeting-settings.png`),
      animations: 'disabled',
    });
    const readCountAfterGreeting = (await readRequests(page)).length;
    await back(page);
    await settingsHub(page, { scope: selectedScope, readCount: readCountAfterGreeting });
    await openSettingsSection(page, 'links', single);
    assert.equal(await policy.inputValue(), '', 'discarded draft restores original mixed state');
    assert.equal(
      await page.evaluate(
        () =>
          window.__networkRequests.filter(
            (row) => row.path.endsWith('/preview') || row.path.endsWith('/apply'),
          ).length,
      ),
      0,
      'discard and section navigation never prepare or save',
    );
    await policy.selectOption('ALERT_ONLY');
    await back(page);
    await leaveDialog.waitFor();
    await back(page);
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(
      await policy.inputValue(),
      'ALERT_ONLY',
      'cancel leaving after section change keeps new draft',
    );
    await fits(page, `${profile.name} mixed settings`);
    await page.screenshot({
      path: join(output, `${profile.name}-mixed-settings.png`),
      animations: 'disabled',
    });
    await page.getByRole('spinbutton', { name: 'Срок ограничения, ч', exact: true }).focus();
    await setPhoneKeyboard(page, { mode: 'resize', height: 230 });
    await fits(page, `${profile.name} settings keyboard`);
    const reviewBox = await page
      .locator('.network-settings-editor')
      .getByRole('button', { name: 'Проверить изменения', exact: true })
      .boundingBox();
    assert.ok(
      reviewBox && reviewBox.y + reviewBox.height <= page.viewportSize().height + 1,
      'group settings action stays above keyboard',
    );
    await setPhoneKeyboard(page, { mode: 'resize', open: false });
    await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    const apply = page.getByRole('button', { name: 'Применить к выбранным', exact: true });
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(
        (node) => node.textContent === 'Применить к выбранным',
      );
      return button && !button.disabled;
    });
    const previewRequest = await page.evaluate(() =>
      window.__networkRequests.find((row) => row.path.endsWith('/preview')),
    );
    assert.deepEqual(previewRequest.body.changes, [
      { path: 'linkPolicy', op: 'set', value: 'ALERT_ONLY' },
    ]);
    assert.equal(previewRequest.body.recipients.length, 2);
    assert.equal('source' in previewRequest.body, false);
    await apply.click();
    await page.getByRole('heading', { name: 'Настройки применены', exact: true }).waitFor();
    const operationCalls = await page.evaluate(() =>
      window.__networkRequests.filter((row) => row.path.endsWith('/apply')),
    );
    assert.equal(operationCalls.length, 1, 'lost apply response is never blindly repeated');
    assert.equal(operationCalls[0].body.operationId, previewRequest.body.operationId);
    assert.equal(
      await page.getByRole('button', { name: /^Проверить повтор для неприменённых/u }).count(),
      0,
    );

    await openSelectedSettings('prepared-reload');
    await page.getByLabel('Режим проверки ссылок', { exact: true }).selectOption('ALERT_ONLY');
    await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Изменения готовы к подтверждению', exact: true })
      .waitFor();
    const preparedOperation = await page.evaluate(
      () => window.__networkRequests.find((row) => row.path.endsWith('/preview')).body.operationId,
    );
    const reloadUrl = new URL(page.url());
    reloadUrl.searchParams.set('preview', '1');
    reloadUrl.searchParams.set('networks', '1');
    reloadUrl.searchParams.set('networksScenario', 'prepared-reload');
    await page.goto(reloadUrl.href);
    await page
      .getByText('Предпросмотр восстановлен для просмотра статуса.', { exact: false })
      .waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Применить к выбранным', exact: true }).count(),
      0,
      'restored PREPARED stays status-only',
    );
    assert.match(
      await page.locator('.network-settings-page__operation').innerText(),
      new RegExp(preparedOperation),
    );

    await openSelectedSettings('prepared-reload');
    const wrongScopeUrl = new URL(page.url());
    wrongScopeUrl.searchParams.set('preview', '1');
    wrongScopeUrl.searchParams.set('networks', '1');
    wrongScopeUrl.searchParams.set('networksScenario', 'prepared-reload');
    wrongScopeUrl.searchParams.set('operation', preparedOperation);
    await page.goto(wrongScopeUrl.href);
    await page
      .getByRole('heading', { name: 'Операция не связана с этим выбором', exact: true })
      .waitFor();
    assert.equal(await page.locator('.network-settings-page__operation').count(), 0);

    if (profile.name === 'iphone-se-dark') {
      await openSelectedSettings('receipt-denied');
      await page.getByLabel('Режим проверки ссылок', { exact: true }).selectOption('ALERT_ONLY');
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (node) => node.textContent === 'Применить к выбранным' && !node.disabled,
        ),
      );
      await page.evaluate(() => {
        window.__networkDeniedWrites = [];
        const originalSet = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('maxim.network.settings.receipts.v1:')) {
            window.__networkDeniedWrites.push({ area: 'local', key });
            throw new Error('Storage denied');
          }
          return originalSet.call(this, key, value);
        };
        const device = (window.MAX?.WebApp ?? window.WebApp).DeviceStorage;
        const originalNativeSet = device.setItem;
        device.setItem = async (key, value) => {
          if (key.startsWith('maxim.network.settings.receipts.v1:')) {
            window.__networkDeniedWrites.push({ area: 'native', key });
            throw new Error('Native storage denied');
          }
          return originalNativeSet.call(device, key, value);
        };
      });
      await page.getByRole('button', { name: 'Применить к выбранным', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /сохранить операцию/u })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => window.__networkRequests.filter((row) => row.path.endsWith('/apply')).length,
        ),
        0,
        'durable receipt failure prevents dispatch',
      );
      assert.ok(
        await page.evaluate(() => window.__networkDeniedWrites.some((row) => row.area === 'local')),
        'local receipt write denial exercised',
      );
      assert.ok(
        await page.evaluate(() =>
          window.__networkDeniedWrites.some((row) => row.area === 'native'),
        ),
        'native receipt write denial exercised',
      );

      await open(
        'networks?type=chat&category=important&tab=communities',
        '[data-network-entity-id]',
        { networks: '1', networksScenario: 'large' },
      );
      await observe(page);
      await page.getByRole('checkbox', { name: /^Выбрать всю сетку/u }).check();
      await page.getByRole('button', { name: /^Настроить/u }).click();
      await settingsHub(page);
      await openSettingsSection(page, 'links');
      assert.ok(
        Number(
          (
            await page.locator('.network-settings-editor .settings-drilldown__summary').innerText()
          ).match(/Выбрано: (\d+)/u)?.[1],
        ) > 500,
        'whole category has no selected-recipient cap',
      );
    }

    await open('?profile=publisher&networks=1', '.publisher-entity-row');
    assert.equal(await page.locator('.bottom-nav__item').count(), 3);
    assert.equal(await page.getByRole('link', { name: 'Сетки', exact: true }).count(), 0);
    assert.equal(await page.locator('body').getAttribute('data-miniapp-profile'), 'publisher');
    await fits(page, `${profile.name} Publisher`);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${profile.name}: actual single/group presentation and fields, lazy hub, restored selection/position, category pagination, mixed drafts, Native Back, keyboard, lost response, durable operation and PREPARED recovery`,
    );
  } catch (error) {
    console.error('FAILED', profile.name, page.url(), await page.locator('body').innerText());
    console.error(
      'STORAGE DIAGNOSTIC',
      await page.evaluate(() => ({
        denied: window.__networkDeniedWrites,
        applyCalls: window.__networkRequests?.filter((row) => row.path.endsWith('/apply')).length,
      })),
    );
    await page.screenshot({
      path: join(output, `${profile.name}-failure.png`),
      animations: 'disabled',
    });
    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}
console.log(`Networks screenshots: ${output}`);
