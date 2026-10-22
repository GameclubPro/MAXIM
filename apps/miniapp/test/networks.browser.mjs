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
  const brokenMetrics = await page
    .locator('.network-card-metric strong, .network-detail-metric > strong')
    .evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
        return lines.size > 1 || node.scrollWidth > node.clientWidth + 1 ? [node.textContent] : [];
      }),
    );
  assert.deepEqual(brokenMetrics, [], `${name}: numeric metrics must fit on one line`);
}

async function numericSamplesFit(page, name, detail = false) {
  const failures = await page
    .locator(detail ? '.network-detail-metric > strong' : '.network-card-metric strong')
    .evaluateAll((nodes, exact) => {
      const originals = nodes.map((node) => node.textContent);
      const formatter = new Intl.NumberFormat(
        'ru-RU',
        exact
          ? {}
          : {
              notation: 'compact',
              maximumFractionDigits: 1,
            },
      );
      const samples = exact
        ? [100_000_000, -100_000_000, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]
        : [337_380, -337_380, 999_900_000, -999_900_000, 999_900_000_000, -999_900_000_000];
      const failures = [];
      try {
        for (const value of samples) {
          const formatted = `${value > 0 ? '+' : ''}${formatter.format(value)}`;
          nodes.forEach((node) => {
            node.textContent = formatted;
          });
          for (const node of nodes) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
            const bounds = node.getBoundingClientRect();
            if (
              lines.size > 1 ||
              node.scrollWidth > node.clientWidth + 1 ||
              bounds.left < -1 ||
              bounds.right > innerWidth + 1
            ) {
              failures.push({
                value: formatted,
                width: node.clientWidth,
                actual: node.scrollWidth,
              });
            }
          }
        }
      } finally {
        nodes.forEach((node, index) => {
          node.textContent = originals[index];
        });
      }
      return failures;
    }, detail);
  assert.deepEqual(
    failures,
    [],
    `${name}: large positive/negative metrics fit without losing digits`,
  );
}

async function observe(page) {
  await page.evaluate(async () => {
    const findModule = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`))?.name;
    const { PREVIEW_REQUEST_HANDLERS } = await import(findModule('preview-transport.ts'));
    const { PREVIEW_NOT_HANDLED } = await import(findModule('preview-transport-runtime.ts'));
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
        const { handleNetworksPreviewRequest } = await import(
          findModule('preview-transport-networks.ts')
        );
        await handleNetworksPreviewRequest(context);
        throw new Error('Preview response lost after committed composition');
      }
      return PREVIEW_NOT_HANDLED;
    });
  });
}

async function back(page) {
  await settleVisualFrame(page);
  await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
}

const LINK_POLICY_LABEL = 'Режим модерации ссылок';
const LINK_PERIOD_LABEL = 'Повторные ссылки: период';
const LINK_PERIOD_ERROR = 'Укажите число от 1 до 168.';
const GREETING_LABEL = 'Включить приветствие новых участников';
const nativeToggle = (label) => ({
  label,
  selector: `label[aria-label="${label}"] input[type="checkbox"]`,
  wrapper: '.settings-native-toggle',
  labelSelector: '.settings-native-toggle__title',
});
const sectionFields = {
  links: [
    {
      label: LINK_POLICY_LABEL,
      selector: `[role="radiogroup"][aria-label="${LINK_POLICY_LABEL}"]`,
      wrapper: '.settings-policy',
      labelSelector: '.field__label',
    },
    ...['период', 'предупреждение', 'ограничение', 'блокировка'].map((label) => ({
      label: `Повторные ссылки: ${label}`,
      selector: `input[aria-label="Повторные ссылки: ${label}"]`,
      wrapper: '.duplicate-stage__field',
      labelSelector: '.duplicate-stage__field-label',
    })),
    nativeToggle('Включить объяснение для модерации ссылок'),
    nativeToggle('Включить предупреждение за повторные ссылки'),
    nativeToggle('3. Ограничение'),
    nativeToggle('Включить блокировку за повторные ссылки'),
  ],
  greeting: [nativeToggle(GREETING_LABEL)],
  greetingExpanded: [
    nativeToggle(GREETING_LABEL),
    {
      label: 'Редактировать текст приветствия',
      selector: 'button[aria-label="Редактировать текст приветствия"]',
      wrapper: '.settings-native-toggle',
      labelSelector: '.settings-native-toggle__title',
    },
    nativeToggle('Включить автоудаление приветственных сообщений бота'),
    {
      label: 'Задержка удаления приветствия',
      selector: '[role="group"][aria-label="Задержка удаления приветствия"]',
      wrapper: '.settings-native-toggle',
      labelSelector: '.settings-native-toggle__title',
    },
    nativeToggle('Добавить кнопку в приветственное сообщение'),
    nativeToggle('Кнопка Правила в приветствии'),
  ],
};
const sectionReady = (panel, section) =>
  section === 'links'
    ? panel.getByRole('radiogroup', { name: LINK_POLICY_LABEL, exact: true })
    : panel.getByLabel(GREETING_LABEL, { exact: true });
function linkPolicy(panel) {
  return panel.getByRole('radiogroup', { name: LINK_POLICY_LABEL, exact: true });
}
async function policyValue(policy) {
  const selected = policy.getByRole('radio', { checked: true });
  assert.ok((await selected.count()) <= 1, 'policy has at most one selected segment');
  return (await selected.count()) ? selected.getAttribute('data-segmented-value') : null;
}
async function selectBlockingPolicy(policy) {
  await policy.getByRole('radio', { name: 'Удалять все', exact: true }).click();
  assert.equal(await policyValue(policy), 'BLOCKLIST_ONLY');
}

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
    const fields = labels.map((spec) => {
      const control = root.querySelector(spec.selector);
      if (!control) throw new Error('Missing canonical field: ' + spec.label);
      const wrapper = control.closest(spec.wrapper);
      if (!wrapper) throw new Error('Missing canonical field wrapper: ' + spec.label);
      const fieldLabel = wrapper.querySelector(spec.labelSelector);
      const classes = (node) => [...node.classList].filter((name) => name !== 'is-active').sort();
      return {
        label: spec.label,
        labelText: fieldLabel.textContent.trim(),
        tag: control.tagName,
        type: control.getAttribute('type'),
        role: control.getAttribute('role'),
        min: control.getAttribute('min'),
        max: control.getAttribute('max'),
        step: control.getAttribute('step'),
        classes: classes(control),
        wrapperTag: wrapper.tagName,
        wrapperClasses: classes(wrapper),
        toggleTrack:
          control.type === 'checkbox'
            ? Boolean(
                control.closest('label').querySelector('.toggle-switch > .toggle-switch__thumb'),
              )
            : null,
        options:
          control.getAttribute('role') === 'radiogroup'
            ? [...control.querySelectorAll('[role="radio"]')].map((option) => ({
                value: option.dataset.segmentedValue,
                label: option.textContent.trim(),
                tag: option.tagName,
                type: option.getAttribute('type'),
                classes: classes(option),
              }))
            : null,
        children:
          control.getAttribute('role') === 'group'
            ? [...control.querySelectorAll('button, input, select')].map((child) => ({
                tag: child.tagName,
                type: child.getAttribute('type'),
                label: child.getAttribute('aria-label'),
                classes: classes(child),
              }))
            : null,
        control: appearance(control),
        wrapper: appearance(wrapper),
        labelStyle: appearance(fieldLabel),
      };
    });
    return {
      title: root.querySelector('.settings-drilldown__title').textContent.trim(),
      classes: [...root.classList].filter((name) => name !== 'network-settings-editor').sort(),
      icon: root.querySelector('.settings-drilldown__symbol')?.innerHTML ?? null,
      titleStyle: appearance(root.querySelector('.settings-drilldown__title')),
      groups: [...root.querySelectorAll('.settings-subsection-divider, .duplicate-stage__top')].map(
        (group) => ({
          title: group.textContent.trim(),
          classes: [...group.classList].sort(),
          style: appearance(group),
        }),
      ),
      fields,
      hasBody: Boolean(root.querySelector('.settings-drilldown__body')),
    };
  }, sectionFields[section]);
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
      await sectionReady(panel, section).waitFor();
      await settleVisualFrame(single);
      sections[section] = await sectionAppearance(panel, section);
      if (section === 'greeting') {
        assert.equal(
          await panel
            .getByLabel('Включить автоудаление приветственных сообщений бота', { exact: true })
            .count(),
          0,
          'disabled greeting hides its dependent controls',
        );
        await panel.getByLabel(GREETING_LABEL, { exact: true }).check();
        await panel
          .getByLabel('Включить автоудаление приветственных сообщений бота', { exact: true })
          .check();
        await panel
          .getByRole('group', { name: 'Задержка удаления приветствия', exact: true })
          .waitFor();
        await settleVisualFrame(single);
        sections.greetingExpanded = await sectionAppearance(panel, 'greetingExpanded');
        continue;
      }
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

async function storedScope(page, scopeId) {
  return page.evaluate((id) => {
    const key = Object.keys(localStorage).find(
      (value) => value.startsWith('maxim.network.settings.scope.v1:') && value.endsWith(':' + id),
    );
    return key ? JSON.parse(localStorage.getItem(key)) : null;
  }, scopeId);
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
  await sectionReady(panel, section).waitFor();
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
    await numericSamplesFit(page, `${profile.name} catalogue`);
    await page.screenshot({
      path: join(output, `${profile.name}-catalogue.png`),
      animations: 'disabled',
    });

    const importantCard = page.locator('.network-summary-card[data-network-category="important"]');
    await importantCard.getByRole('button', { name: 'Настройки', exact: true }).click();
    const directScope = await settingsHub(page);
    assert.deepEqual(
      (await storedScope(page, directScope)).scope.target,
      {
        mode: 'category',
        favoriteType: 'important',
      },
      'card Settings targets the complete favorite category without selecting recipients',
    );
    await back(page);
    await importantCard.waitFor();

    await page.locator('.network-summary-card__open').first().click();
    await page.locator('.network-detail-metric').first().waitFor();
    await fits(page, `${profile.name} network statistics`);
    await numericSamplesFit(page, `${profile.name} network statistics`, true);
    await page.screenshot({
      path: join(output, `${profile.name}-statistics.png`),
      animations: 'disabled',
    });
    const configure = page.getByRole('button', { name: 'Настройки', exact: true });
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
        ).match(/(?:Выбрано|Вся сетка): (\d+)/u)?.[1],
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
    assert.equal(
      await page.getByRole('radio', { name: 'Статистика', exact: true }).isChecked(),
      true,
      'Back restores the Statistics tab that opened Settings',
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

    await page.getByRole('radio', { name: /^Состав/u }).click();
    await page.locator('[data-network-entity-id]').first().waitFor();
    assert.equal(await page.locator('[data-network-entity-id]').count(), 50);
    assert.equal(
      await page.locator('.network-community-list input').count(),
      0,
      'network membership is not a second settings-recipient picker',
    );

    await page.getByRole('button', { name: 'Показать ещё', exact: true }).click();
    await page.locator('[data-network-entity-id]').nth(50).waitFor();
    await page.locator('[data-network-entity-id]').last().scrollIntoViewIfNeeded();
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
      await page.getByRole('radio', { name: /^Состав/u }).isChecked(),
      true,
      'Back restores the Composition tab that opened Settings',
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
    await configure.click();
    const changedCompositionScope = await settingsHub(page, {
      readCount: (await readRequests(page)).length,
    });
    assert.deepEqual(
      (await storedScope(page, changedCompositionScope)).scope.target,
      {
        mode: 'category',
        favoriteType: 'important',
      },
      'composition changes keep Settings targeted at the whole network',
    );
    await back(page);
    await page
      .getByRole('combobox', { name: 'Переключить сетку', exact: true })
      .selectOption('watch');
    await configure.click();
    const switchedScope = await settingsHub(page, { readCount: (await readRequests(page)).length });
    assert.deepEqual(
      (await storedScope(page, switchedScope)).scope.target,
      {
        mode: 'category',
        favoriteType: 'watch',
      },
      'switching networks never carries recipients from the previous category',
    );
    await back(page);
    assert.equal(
      await page.getByRole('combobox', { name: 'Переключить сетку', exact: true }).inputValue(),
      'watch',
    );
    await settleVisualFrame(page);
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
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      const category = await settingsHub(page);
      // Retain the existing selected-target recovery coverage through an explicit test scope.
      const selectedScopeId = await page.evaluate(async (scopeId) => {
        const source = performance
          .getEntriesByType('resource')
          .findLast((entry) =>
            new URL(entry.name).pathname.endsWith('/network-settings-workspace-state.ts'),
          )?.name;
        const { createNetworkSettingsScope } = await import(source);
        const key = Object.keys(localStorage).find(
          (value) =>
            value.startsWith('maxim.network.settings.scope.v1:') && value.endsWith(':' + scopeId),
        );
        const stored = JSON.parse(localStorage.getItem(key));
        return createNetworkSettingsScope({
          userId: stored.userId,
          title: stored.title,
          returnTo: stored.returnTo,
          scope: {
            ...stored.scope,
            target: {
              mode: 'selected',
              entityIds: ['preview-network-chat-0001', 'preview-network-chat-0002'],
            },
          },
        }).scopeId;
      }, category);
      await open(
        `networks/chat/settings?scope=${selectedScopeId}`,
        '[data-network-settings-overview]',
        {
          networks: '1',
          networksScenario: scenario,
        },
      );
      await observe(page);
      const scope = await settingsHub(page);
      await openSettingsSection(page, 'links');
      return scope;
    };
    const selectedScope = await openSelectedSettings('uncertain');
    const policy = linkPolicy(page.locator('.network-settings-editor'));
    assert.equal(await policyValue(policy), null, 'different settings remain mixed');
    await policy.getByRole('radio').first().focus();
    await policy.getByRole('radio').first().blur();
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isDisabled(),
      true,
      'focus cannot create a draft',
    );
    const leaveDialog = page.getByRole('dialog', { name: 'Выйти без сохранения?', exact: true });
    const invalidNumber = page
      .locator('.network-settings-editor')
      .getByRole('spinbutton', { name: LINK_PERIOD_LABEL, exact: true });
    const originalNumber = await invalidNumber.inputValue();
    await invalidNumber.fill('0');
    await page.getByText(LINK_PERIOD_ERROR, { exact: true }).waitFor();
    assert.equal(
      await page.locator('.network-settings-editor .network-settings-page__changes').count(),
      0,
      'invalid raw number alone creates no valid field change',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isDisabled(),
      true,
      'invalid-only draft cannot prepare changes',
    );
    await back(page);
    await leaveDialog.waitFor();
    await back(page);
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(await invalidNumber.inputValue(), '0', 'cancel leaving keeps invalid raw number');
    assert.equal(
      await page.getByText(LINK_PERIOD_ERROR, { exact: true }).isVisible(),
      true,
      'cancel leaving keeps field error',
    );
    const readCountBeforeInvalidDiscard = (await readRequests(page)).length;
    await back(page);
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
    await settingsHub(page, {
      scope: selectedScope,
      readCount: readCountBeforeInvalidDiscard,
    });
    await openSettingsSection(page, 'links', single);
    assert.equal(
      await invalidNumber.inputValue(),
      originalNumber,
      'discarding invalid-only draft restores original field value',
    );
    assert.equal(await page.getByText(LINK_PERIOD_ERROR, { exact: true }).count(), 0);
    assert.equal(
      await policyValue(policy),
      null,
      'invalid-only discard does not author mixed policy',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isDisabled(),
      true,
      'invalid-only discard clears error state and all changes',
    );
    await back(page);
    await settingsHub(page, { scope: selectedScope, readCount: (await readRequests(page)).length });
    assert.equal(await leaveDialog.count(), 0, 'discarded errors do not leave a stale dirty guard');
    await openSettingsSection(page, 'links', single);
    await selectBlockingPolicy(policy);
    await back(page);
    await leaveDialog.waitFor();
    await back(page);
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(await policyValue(policy), 'BLOCKLIST_ONLY', 'cancel leaving keeps draft');
    await back(page);
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
    await settingsHub(page, { scope: selectedScope, readCount: (await readRequests(page)).length });
    await openSettingsSection(page, 'greeting', single);
    assert.equal(
      await page.getByRole('radiogroup', { name: LINK_POLICY_LABEL, exact: true }).count(),
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
    const greetingPanel = page.locator('.network-settings-editor');
    assert.equal(
      await greetingPanel
        .getByLabel('Включить автоудаление приветственных сообщений бота', { exact: true })
        .count(),
      0,
      'disabled greeting hides the same dependent controls in group mode',
    );
    await greetingPanel.getByLabel(GREETING_LABEL, { exact: true }).check();
    await greetingPanel
      .getByLabel('Включить автоудаление приветственных сообщений бота', { exact: true })
      .check();
    await greetingPanel
      .getByRole('group', { name: 'Задержка удаления приветствия', exact: true })
      .waitFor();
    await settleVisualFrame(page);
    assert.deepEqual(
      await sectionAppearance(greetingPanel, 'greetingExpanded'),
      single.sections.greetingExpanded,
      'expanded greeting uses the same original editor buttons, toggles and delay stepper',
    );
    assert.equal(
      await page.getByRole('button', { name: 'Проверить изменения', exact: true }).isEnabled(),
      true,
      'explicit greeting changes create a reviewable draft',
    );
    const readCountAfterGreeting = (await readRequests(page)).length;
    await back(page);
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
    await settingsHub(page, { scope: selectedScope, readCount: readCountAfterGreeting });
    await openSettingsSection(page, 'links', single);
    assert.equal(await policyValue(policy), null, 'discarded draft restores original mixed state');
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
    await selectBlockingPolicy(policy);
    await back(page);
    await leaveDialog.waitFor();
    await back(page);
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(
      await policyValue(policy),
      'BLOCKLIST_ONLY',
      'cancel leaving after section change keeps new draft',
    );
    await fits(page, `${profile.name} mixed settings`);
    await page.screenshot({
      path: join(output, `${profile.name}-mixed-settings.png`),
      animations: 'disabled',
    });
    await page.getByRole('spinbutton', { name: LINK_PERIOD_LABEL, exact: true }).focus();
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
      { path: 'linkPolicy', op: 'set', value: 'BLOCKLIST_ONLY' },
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
    await selectBlockingPolicy(linkPolicy(page.locator('.network-settings-editor')));
    await page.getByRole('button', { name: 'Проверить изменения', exact: true }).click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('button')].some(
        (node) => node.textContent.trim() === 'Применить к выбранным' && !node.disabled,
      ),
    );
    const preparedOperation = await page.evaluate(
      () => window.__networkRequests.find((row) => row.path.endsWith('/preview')).body.operationId,
    );
    await settleVisualFrame(page);
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
    await page.getByText('Подробности применения', { exact: true }).click();
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
      await selectBlockingPolicy(linkPolicy(page.locator('.network-settings-editor')));
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
      await page.getByRole('button', { name: 'Настройки', exact: true }).click();
      await settingsHub(page);
      await openSettingsSection(page, 'links');
      assert.ok(
        Number(
          (
            await page.locator('.network-settings-editor .settings-drilldown__summary').innerText()
          ).match(/(?:Выбрано|Вся сетка): (\d+)/u)?.[1],
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
      `PASS ${profile.name}: whole-category settings from cards and statistics, category switching and composition, original settings parity, restored tab/position, pagination, mixed drafts, Native Back, keyboard, lost response and durable recovery`,
    );
  } catch (error) {
    console.error('FAILED', profile.name, page.url());
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
