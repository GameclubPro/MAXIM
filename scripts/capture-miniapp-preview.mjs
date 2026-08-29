import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import previewDevicePresets from '../apps/miniapp/src/lib/preview-device-presets.json' with { type: 'json' };
import {
  ensureMiniappDevServer,
  isLocalMiniappBaseUrl,
  stopChildProcess,
  waitForMiniappUrl,
} from './miniapp-local-server.mjs';
import { assertMaxBridgeShim, installMaxBridgeShimInitScript } from './miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from './miniapp-native-visual-mode.mjs';
import {
  resolveMiniappScreenshotBaseUrl,
  resolveMiniappVisualNow,
  resolveScenarioRuntime,
} from './miniapp-visual-config.mjs';
import {
  MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES,
  MINIAPP_VISUAL_PRESETS,
  MINIAPP_VISUAL_SCENARIOS,
  selectMiniappVisualScenarios,
} from './miniapp-visual-scenarios.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const OUTPUT_ROOT = path.join(ROOT_DIR, 'artifacts/miniapp-screenshots');
const runLabel = (process.env.MINIAPP_SCREENSHOT_LABEL ?? '').trim();
const timestamp =
  runLabel.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') ||
  new Date().toISOString().replace(/[:.]/g, '-');

const deviceProfiles = previewDevicePresets;
const visualPresetName = (process.env.MINIAPP_SCREENSHOT_PRESET ?? '').trim().toLowerCase();
const visualPreset = MINIAPP_VISUAL_PRESETS[visualPresetName];

const screenshotTarget = (process.env.MINIAPP_SCREENSHOT_TARGET ?? visualPreset?.target ?? 'device')
  .trim()
  .toLowerCase();
const colorScheme = (process.env.MINIAPP_SCREENSHOT_COLOR_SCHEME ?? 'light').trim().toLowerCase();
const strictLayout =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_LAYOUT') ?? visualPreset?.checks?.layout ?? false;
const strictContrast =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_CONTRAST') ??
  visualPreset?.checks?.contrast ??
  false;
const strictAccessibility =
  parseOptionalEnvFlag('MINIAPP_SCREENSHOT_STRICT_ACCESSIBILITY') ??
  visualPreset?.checks?.accessibility ??
  false;
const envMaxBridgeShim = parseOptionalEnvFlag('MINIAPP_SCREENSHOT_MAX_BRIDGE');
const maxBridgeShimEnabled = envMaxBridgeShim ?? screenshotTarget === 'native';
const reuseServer = parseEnvFlag('MINIAPP_SCREENSHOT_REUSE_SERVER');
const visualNow = resolveMiniappVisualNow();
const simulateKeyboard = parseEnvFlag('MINIAPP_SCREENSHOT_SIMULATE_KEYBOARD');
const keyboardOverlapPx = Number.parseInt(
  process.env.MINIAPP_SCREENSHOT_KEYBOARD_OVERLAP_PX ?? '320',
  10,
);
const normalizedKeyboardOverlapPx = Number.isFinite(keyboardOverlapPx)
  ? Math.max(160, Math.min(keyboardOverlapPx, 420))
  : 320;
const KEYBOARD_MIN_VISIBLE_HEIGHT_PX = 280;
const KEYBOARD_MIN_REDUCTION_PX = 80;
const PUBLISHER_COMPOSER_KEYBOARD_SCENARIO = 'publications-publisher-compose';
const PUBLISHER_BUTTONS_KEYBOARD_SCENARIO = 'publications-publisher-buttons-keyboard';
const PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO = 'publisher-auto-replies-editor-keyboard';
const KEYBOARD_SCENARIO_PROFILES = Object.freeze({
  [PUBLISHER_COMPOSER_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-composer',
    focusSelector: '.publication-content-composer .max-rich-text-editor__surface',
    focusReport: 'publisher-rich-text-editor',
    actionBarSelector: '.publications-publish-bar',
    primarySelector: '.broadcast-publish-bar__primary',
    allowActionBelowViewport: true,
    expectPageKeyboardState: true,
    pickerSheetSelector: '.publication-target-picker__editor.is-sheet',
    focusFailure: 'Publisher keyboard scenario did not finish with focus in the rich-text editor.',
    focusLabel: 'Publisher rich-text editor',
    actionBarLabel: 'Publisher publish bar',
    primaryFailure: 'Publisher primary publish action does not contain its label at keyboard size.',
    pickerFailure: 'Publisher recipient picker remained open after keyboard focus-flow checks.',
  }),
  [PUBLISHER_BUTTONS_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-buttons',
    focusSelector: ".publication-buttons-sheet input[type='url']",
    focusReport: 'publisher-button-url',
    actionBarSelector: '.publication-buttons-sheet__footer',
    primarySelector: '.publication-buttons-sheet__done',
    expectPageKeyboardState: true,
    pickerSheetSelector: null,
    focusFailure: 'Publisher button URL did not keep keyboard focus.',
    focusLabel: 'Publisher button URL',
    actionBarLabel: 'Publisher button actions',
    primaryFailure: 'Publisher button Done action does not contain its label at keyboard size.',
    pickerFailure: null,
  }),
  [PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO]: Object.freeze({
    flow: 'publisher-auto-reply-editor',
    focusSelector: '.publisher-auto-reply-editor [aria-label="Текст автоответа"]',
    focusReport: 'publisher-auto-reply-text-editor',
    actionBarSelector: '.publisher-auto-reply-editor__save-bar',
    primarySelector: 'button',
    pickerSheetSelector: null,
    focusFailure: 'Auto-reply keyboard scenario did not finish with focus in the text editor.',
    focusLabel: 'Auto-reply text editor',
    actionBarLabel: 'Auto-reply save bar',
    primaryFailure: 'Auto-reply primary save action does not contain its label at keyboard size.',
    pickerFailure: null,
  }),
});

function resolveKeyboardScenarioProfile(scenario) {
  return KEYBOARD_SCENARIO_PROFILES[scenario.name] ?? null;
}

function shouldSimulateKeyboardScenario(scenario) {
  return scenario.keyboard === false ? false : simulateKeyboard || scenario.keyboard === true;
}

function parseEnvFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function parseOptionalEnvFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') {
    return true;
  }
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') {
    return false;
  }
  return null;
}

async function openSettingsSection(page, name, panelSelector) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.locator(panelSelector).waitFor({ state: 'visible' });
  await page.waitForTimeout(350);
}

async function waitForModerationEventsReady(page) {
  await page
    .locator('.events-dashboard__body--moderation:not(.events-dashboard__body--loading)')
    .waitFor({ state: 'visible' });
  await page
    .locator('.event-feed-item, .events-inline-state')
    .first()
    .waitFor({ state: 'visible' });
}

async function waitForActivityEventsReady(page) {
  await page
    .locator('.events-dashboard__activity:not(.events-dashboard__activity--loading)')
    .waitFor({ state: 'visible' });
}

async function waitForChannelStatsReady(page) {
  await page
    .locator('.channel-insights__summary[aria-label="Сводка по каналу"]')
    .waitFor({ state: 'visible' });
}

async function waitForChannelEventsReady(page) {
  await page.locator('.channel-events-section').waitFor({ state: 'visible' });
  await page
    .locator('.channel-events-section__metrics[aria-busy="false"]')
    .waitFor({ state: 'visible' });
  await page
    .locator(
      '.channel-events-section .membership-feed__card, .channel-events-section .membership-feed__status',
    )
    .first()
    .waitFor({ state: 'visible' });
}

async function openPreviewGiveawayEditor(page) {
  const giveaway = page.locator('.managed-giveaway');
  await giveaway.waitFor({ state: 'visible' });
  const editButton = giveaway.getByRole('button', {
    name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
  });
  await editButton.first().waitFor({ state: 'visible' });
  await editButton.first().click();
  await page.locator('.managed-giveaway--step-basics').waitFor({ state: 'visible' });
}

async function openPreviewPollEditor(page, { openSection = false } = {}) {
  if (openSection) {
    await openSettingsSection(page, 'Опросы', '.managed-poll-workspace');
  } else {
    await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
  }

  const workspace = page.locator('.managed-poll-workspace');
  await workspace.getByRole('button', { name: 'Новый', exact: true }).click();
  await page.locator('.managed-poll-editor').waitFor({ state: 'visible' });
}

async function openPublisherAutoReplyCreateSheet(page) {
  await page.getByRole('button', { name: 'Добавить автоответ', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый автоответ' });
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('button', { name: 'Создать здесь', exact: true }).waitFor({
    state: 'visible',
  });
  return dialog;
}

async function openPublisherAutoReplyEditor(page) {
  const dialog = await openPublisherAutoReplyCreateSheet(page);
  await dialog.getByRole('button', { name: 'Создать здесь', exact: true }).click();
  const editor = page.locator('.publisher-auto-reply-editor');
  await editor.waitFor({ state: 'visible' });
  await editor.getByRole('textbox', { name: /Кодовая фраза/u }).fill('Каталог');
  await editor
    .getByRole('textbox', { name: 'Текст автоответа', exact: true })
    .fill('Каталог готов. Выберите нужный раздел.');
  await page.waitForTimeout(250);
  return editor;
}

async function openPublisherButtonsSheet(page) {
  const editor = page.locator('.publications-editor');
  await editor.waitFor({ state: 'visible' });
  const composer = editor.locator('.publication-content-composer');
  const trigger = composer.getByRole('button', { name: /кнопк/iu }).first();
  await trigger.waitFor({ state: 'visible' });
  await trigger.getByText('Кнопка', { exact: true }).waitFor({ state: 'visible' });
  await trigger.click();

  const sheet = page.locator('.publication-buttons-sheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByRole('dialog', { name: 'Кнопки', exact: true }).waitFor({ state: 'visible' });
  return { sheet, trigger };
}

async function assertPublisherButtonsSheetIsDirect(sheet) {
  if ((await sheet.getByRole('checkbox').count()) !== 0) {
    throw new Error('Publisher buttons sheet restored the obsolete enable toggle.');
  }
  if ((await sheet.getByText(/^(?:Включены|Выключены)$/u).count()) !== 0) {
    throw new Error('Publisher buttons sheet restored obsolete enable-state copy.');
  }
  await sheet.getByLabel('Название', { exact: true }).first().waitFor({ state: 'visible' });
  await sheet.getByLabel('Ссылка', { exact: true }).first().waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Ещё', exact: true }).waitFor({ state: 'visible' });
  await sheet.getByRole('button', { name: 'Готово', exact: true }).waitFor({ state: 'visible' });
  const crowdedField = await sheet
    .locator('.publication-buttons-sheet__field')
    .evaluateAll((labels) =>
      labels
        .map((label, index) => {
          const caption = label.querySelector('span');
          const input = label.querySelector('input');
          if (!(caption instanceof HTMLElement) || !(input instanceof HTMLInputElement)) {
            return null;
          }
          return {
            index,
            gap: input.getBoundingClientRect().top - caption.getBoundingClientRect().bottom,
          };
        })
        .find((field) => field && field.gap < 4),
    );
  if (crowdedField) {
    throw new Error(
      `Publisher button field ${crowdedField.index + 1} label touches its input ` +
        `(gap=${crowdedField.gap.toFixed(1)}px).`,
    );
  }
}

async function assertPublisherButtonsSheetHasDefaultButton(sheet, stage = 'open') {
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const values = { name: await name.inputValue(), url: await url.inputValue() };
  if (values.name !== 'Открыть' || values.url !== '') {
    throw new Error(
      `Publisher buttons sheet did not restore its default first button at ${stage}: ` +
        JSON.stringify(values),
    );
  }
}

async function assertPublisherButtonTriggerIsEmpty(page, trigger) {
  await trigger.getByText('Кнопка', { exact: true }).waitFor({ state: 'visible' });
  if (
    (await page
      .locator('.publication-content-composer .broadcast-message-card__button')
      .count()) !== 0
  ) {
    throw new Error('Discarded publisher button leaked into the publication preview.');
  }
}

async function waitForPublisherButtonsSheetClosed(page, sheet) {
  await sheet.waitFor({ state: 'detached' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
}

async function publishPreviewPoll(page) {
  const editor = page.locator('.managed-poll-editor');
  const question = 'Когда проведём следующую встречу?';
  await editor.getByRole('textbox', { name: 'Вопрос опроса' }).fill(question);
  await editor.getByRole('textbox', { name: 'Вариант ответа 1' }).fill('В пятницу');
  await editor.getByRole('textbox', { name: 'Вариант ответа 2' }).fill('В субботу');
  await editor.getByRole('button', { name: 'Опубликовать', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Опубликовать опрос?' });
  await confirm.waitFor({ state: 'visible' });
  await confirm.getByRole('button', { name: 'Опубликовать', exact: true }).click();

  const publishedToast = page.locator('.toast').filter({ hasText: 'Опрос опубликован' });
  await publishedToast.waitFor({ state: 'visible' });
  await page
    .locator('.managed-poll-item')
    .filter({ hasText: question })
    .waitFor({ state: 'visible' });
}

async function savePreviewPollDraft(page) {
  const editor = page.locator('.managed-poll-editor');
  const question = 'Когда проведём следующую встречу?';
  await editor.getByRole('textbox', { name: 'Вопрос опроса' }).fill(question);
  await editor.getByRole('textbox', { name: 'Вариант ответа 1' }).fill('В пятницу');
  await editor.getByRole('textbox', { name: 'Вариант ответа 2' }).fill('В субботу');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();

  const savedToast = page.locator('.toast').filter({ hasText: 'Черновик сохранён' });
  await savedToast.waitFor({ state: 'visible' });
  await savedToast.getByRole('button', { name: 'Закрыть уведомление' }).click();
  await savedToast.waitFor({ state: 'detached' });
  await editor.getByRole('button', { name: 'Назад к списку', exact: true }).click();

  const draft = page.locator('.managed-poll-item').filter({ hasText: question });
  await draft.locator('.managed-poll-item__status.is-draft').waitFor({ state: 'visible' });
}

async function assertBotMessagePlaceholderRoundTrip(page) {
  const expectedKeys = ['user', 'message_status', 'reason'];
  const editor = page.locator('.max-rich-text-editor__surface');
  const readEditorState = () =>
    editor.evaluate((element) => ({
      keys: Array.from(element.querySelectorAll('[data-max-placeholder]')).map(
        (token) => token.getAttribute('data-max-placeholder') ?? '',
      ),
      text: element.textContent ?? '',
    }));

  const initialState = await readEditorState();
  if (JSON.stringify(initialState.keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`Bot message placeholders are incomplete: ${JSON.stringify(initialState)}.`);
  }

  await editor.evaluate((element) => {
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.insertText(' Проверка');
  await page.getByRole('button', { name: 'Готово', exact: true }).click();
  await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'detached' });

  await page
    .getByRole('button', { name: 'Редактировать текст сообщения о ссылках', exact: true })
    .click();
  await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'visible' });
  const reopenedState = await readEditorState();
  if (
    JSON.stringify(reopenedState.keys) !== JSON.stringify(expectedKeys) ||
    !reopenedState.text.includes('Проверка')
  ) {
    throw new Error(`Bot message placeholder round-trip failed: ${JSON.stringify(reopenedState)}.`);
  }

  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).waitFor({ state: 'detached' });
  const resetState = await readEditorState();
  if (
    JSON.stringify(resetState.keys) !== JSON.stringify(expectedKeys) ||
    resetState.text.includes('Проверка')
  ) {
    throw new Error(`Bot message reset lost placeholders: ${JSON.stringify(resetState)}.`);
  }
}

async function setScrollPosition(scrollBody, top, label) {
  await scrollBody.waitFor({ state: 'visible' });
  const metrics = await scrollBody.evaluate((element, requestedTop) => {
    const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    const nextTop = requestedTop === 'bottom' ? maxScrollTop : Math.min(requestedTop, maxScrollTop);
    element.scrollTo({ top: nextTop, behavior: 'instant' });
    return {
      clientHeight: element.clientHeight,
      maxScrollTop,
      requestedTop: nextTop,
    };
  }, top);
  await scrollBody.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const scrollTop = await scrollBody.evaluate((element) => element.scrollTop);
  if (Math.abs(scrollTop - metrics.requestedTop) > 1) {
    throw new Error(
      `${label} did not reach scroll position ${metrics.requestedTop} (actual ${scrollTop}).`,
    );
  }
  return { ...metrics, scrollTop };
}

async function setSettingsDrilldownScroll(page, top) {
  const scrollBody = page.locator('.settings-drilldown:visible .settings-drilldown__body').first();
  return setScrollPosition(scrollBody, top, 'Settings drilldown');
}

async function scrollSettingsDrilldownToBottom(page) {
  await setSettingsDrilldownScroll(page, 'bottom');
  const nestedScrollSelectors = [
    '.bot-message-editor-sheet:visible .bot-message-editor-sheet__body',
    '.broadcast-audience-sheet:visible .broadcast-audience-sheet__scroll',
    '.managed-giveaway-modal:visible .managed-giveaway-modal__sheet',
  ];
  for (const selector of nestedScrollSelectors) {
    const scrollBody = page.locator(selector).first();
    if ((await scrollBody.count()) > 0) {
      await setScrollPosition(scrollBody, 'bottom', selector);
    }
  }
}

const scenarioBehaviors = [
  {
    name: 'home',
  },
  {
    name: 'home-channels',
  },
  {
    name: 'home-filter',
    beforeShot: async (page) => {
      const trigger = page.locator('.favorite-filter__trigger');
      const panel = page.locator('.home-filter__panel');
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await page.locator('.favorite-picker__backdrop').click({ position: { x: 2, y: 2 } });
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter sheet did not restore focus after outside click.');
      }
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter sheet did not restore focus after Escape.');
      }
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
    },
  },
  {
    name: 'home-filter-active',
    beforeShot: async (page) => {
      const trigger = page.locator('.favorite-filter__trigger');
      const panel = page.locator('.home-filter__panel');
      await trigger.click();
      await panel.waitFor({ state: 'visible' });
      await panel.locator('.home-filter__item.is-important').click();
      await panel.waitFor({ state: 'detached' });
      await page.waitForTimeout(50);
      if ((await trigger.getAttribute('aria-label')) !== 'Фильтр: Важные') {
        throw new Error('Home filter trigger did not expose the selected category.');
      }
      if (!(await trigger.evaluate((element) => element === document.activeElement))) {
        throw new Error('Home filter trigger did not regain focus after category selection.');
      }
      if ((await page.locator('.chat-card').count()) !== 1) {
        throw new Error('Home category filter did not reduce the preview list to one entity.');
      }
    },
  },
  {
    name: 'home-category-edit',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Фильтр категорий' }).click();
      await page.getByRole('button', { name: 'Распределить по категориям' }).click();
      await page.getByRole('button', { name: 'Готово' }).waitFor({ state: 'visible' });
      if ((await page.locator('.chat-card__action--statistics').count()) !== 0) {
        throw new Error('Home category edit mode still exposes statistics actions.');
      }
    },
  },
  {
    name: 'home-favorite-picker',
    beforeShot: async (page) => {
      await page.locator('.chat-card__action--favorite').first().click();
      await page.locator('.favorite-picker__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'home-favorite-categories',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Фильтр категорий' }).click();
      await page.getByRole('button', { name: 'Настроить названия' }).click();
      await page.locator('.favorite-label-editor__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__list').waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-channels',
    beforeShot: async (page) => {
      await page.getByRole('list', { name: 'Каналы Публика' }).waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-channel-only',
    beforeShot: async (page) => {
      await page.waitForURL((url) => url.searchParams.get('view') === 'channel');
      await page.getByRole('list', { name: 'Каналы Публика' }).waitFor({ state: 'visible' });
      await page.locator('.publisher-entity-row').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /модули/iu })
        .first()
        .click();
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Постинг', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-modules',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /модули/iu })
        .first()
        .click();
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Предложки', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules-vk',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /модули/iu })
        .first()
        .click();
      await page.getByRole('button', { name: 'Открыть посты из VK', exact: true }).click();
      await page.locator('.publisher-entity-vk-module .vk-parsing-card').waitFor({
        state: 'visible',
      });
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'publisher-channel-modules-vk-editor',
    beforeShot: async (page) => {
      await page
        .getByRole('link', { name: /модули/iu })
        .first()
        .click();
      await page.getByRole('button', { name: 'Открыть посты из VK', exact: true }).click();
      const card = page.locator('.publisher-entity-vk-module .vk-parsing-card');
      await card.waitFor({ state: 'visible' });
      await card.getByRole('button', { name: 'Редактировать', exact: true }).first().click();
      await card.locator('.vk-parsing-editor__composer').waitFor({ state: 'visible' });
      await card.getByRole('button', { name: 'Форматирование', exact: true }).click();
      await card.locator('.vk-parsing-editor__format-tools').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'publisher-entities-empty',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__state').waitFor({ state: 'visible' });
      await page
        .getByRole('button', { name: 'Открыть диалог Публика', exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entity-modules-blocked',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page
        .getByRole('button', { name: 'Проверить', exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-suggestions-confirm',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Опубликовать', exact: true }).first().click();
      const dialog = page.getByRole('dialog', { name: 'Опубликовать предложку?' });
      await dialog.waitFor({ state: 'visible' });
      const preview = dialog.locator('.publisher-suggestion-confirm__text');
      if (/\*\*|\+\+|~~/u.test((await preview.textContent()) ?? '')) {
        throw new Error('Publisher suggestion confirmation leaked Markdown markers.');
      }
      await preview.locator('strong').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-suggestions-cancel-confirm',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Отклонить', exact: true }).first().click();
      await page
        .getByRole('dialog', { name: 'Отклонить предложку?' })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-suggestions-history',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /История/u }).click();
      const loadMore = page.getByRole('button', { name: /Показать ещё/u });
      await loadMore.waitFor({ state: 'visible' });
      await loadMore.press('Enter');
      await page.getByText('Публикация создана', { exact: true }).first().waitFor({
        state: 'visible',
      });
    },
  },
  {
    name: 'publisher-entities-error',
    beforeShot: async (page) => {
      await page.locator('.publisher-entities-page__state.has-error').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-entities-large',
    beforeShot: async (page) => {
      const loadMore = page.locator('.publisher-entities-page__load-more');
      await loadMore.waitFor({ state: 'visible' });
      await loadMore.press('Enter');
      await loadMore.getByText('Показать ещё', { exact: true }).waitFor({ state: 'visible' });
      await loadMore.press('Enter');
      const list = page.locator('.publisher-entities-page__list.is-virtual');
      await list.waitFor({ state: 'visible' });
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.waitForTimeout(120);
    },
  },
  {
    name: 'publisher-auto-replies-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-auto-replies-page').waitFor({ state: 'visible' });
      await page.locator('.publisher-auto-reply-row').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'publisher-auto-replies-create-sheet',
    beforeShot: async (page) => {
      await openPublisherAutoReplyCreateSheet(page);
      await page.waitForTimeout(150);
    },
  },
  {
    name: 'publisher-auto-replies-editor',
    beforeShot: async (page) => {
      await openPublisherAutoReplyEditor(page);
    },
  },
  {
    name: 'publisher-auto-replies-editor-bottom',
    beforeShot: async (page) => {
      const editor = await openPublisherAutoReplyEditor(page);
      const settings = editor.locator('.publisher-auto-reply-editor__section').last();
      await settings.waitFor({ state: 'visible' });
      await settings.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      await page.waitForTimeout(120);
      await assertLocatorWithinViewport(settings, 'Auto-reply settings section');
      await assertLocatorWithinViewport(
        editor.locator('.publisher-auto-reply-editor__save-bar button'),
        'Auto-reply save action',
      );
    },
  },
  {
    name: PUBLISHER_AUTO_REPLY_KEYBOARD_SCENARIO,
    beforeShot: async (page) => {
      await openPublisherAutoReplyEditor(page);
    },
  },
  {
    name: 'publications',
    beforeShot: async (page) => {
      await page.locator('.publications-page').waitFor({ state: 'visible' });
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'publications-publisher',
    beforeShot: async (page) => {
      await page.locator('.publication-publisher-status').waitFor({ state: 'visible' });
      await page.getByText(/2 готовы/u).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-create',
    beforeShot: async (page) => {
      const dialog = page.getByRole('dialog', { name: 'Новый пост' });
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Написать' }).waitFor({ state: 'visible' });
      await dialog.getByRole('button', { name: 'Переслать' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-schedules',
    beforeShot: async (page) => {
      await page.locator('.publications-tabs button.is-active').getByText('Расписания').waitFor();
    },
  },
  {
    name: 'publications-publisher-history',
    beforeShot: async (page) => {
      await page.locator('.publications-tabs button.is-active').getByText('История').waitFor();
    },
  },
  {
    name: 'publications-publisher-empty',
    beforeShot: async (page) => {
      await page
        .getByText('Нет подключённых получателей', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-large',
    beforeShot: async (page) => {
      await page.locator('.publication-publisher-status').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-error',
    beforeShot: async (page) => {
      await page
        .getByText('Получатели временно недоступны', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      const summary = page.locator('.publication-target-picker__summary');
      const sheet = page.locator('.publication-target-picker__editor.is-sheet');
      await summary.click();
      await sheet.waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await sheet.waitFor({ state: 'detached' });
      if (!(await summary.evaluate((element) => element === document.activeElement))) {
        throw new Error('Publisher recipient summary did not regain focus after Escape.');
      }
      await summary.click();
      await page.locator('.publication-target-picker__list').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-buttons-empty',
    beforeShot: async (page) => {
      const { sheet, trigger } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'initial open');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Не сохранять');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/discard');
      await page.keyboard.press('Escape');
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after Escape');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Тоже не сохранять');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/discard-2');
      await sheet
        .locator('.publication-buttons-sheet__backdrop')
        .click({ position: { x: 2, y: 2 } });
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after backdrop');
    },
  },
  {
    name: 'publications-publisher-buttons-filled',
    beforeShot: async (page) => {
      const { sheet, trigger } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      const previewButton = page
        .locator('.publication-content-composer .broadcast-message-card__button')
        .filter({ hasText: 'Подробнее' });
      await previewButton.waitFor({ state: 'visible' });
      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      if (
        (await sheet.getByLabel('Название', { exact: true }).first().inputValue()) !==
          'Подробнее' ||
        (await sheet.getByLabel('Ссылка', { exact: true }).first().inputValue()) !==
          'https://max.ru/publik'
      ) {
        throw new Error('Publisher button values did not survive Done and reopening.');
      }
      await sheet.getByRole('button', { name: 'Убрать кнопку 1', exact: true }).click();
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await assertPublisherButtonTriggerIsEmpty(page, trigger);

      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'reopen after removing last');
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
      await sheet.getByLabel('Ссылка', { exact: true }).first().fill('https://max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      await previewButton.waitFor({ state: 'visible' });
      await trigger.click();
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      if (
        (await sheet.getByLabel('Название', { exact: true }).first().inputValue()) !==
          'Подробнее' ||
        (await sheet.getByLabel('Ссылка', { exact: true }).first().inputValue()) !==
          'https://max.ru/publik'
      ) {
        throw new Error('Restored publisher button values did not survive reopening.');
      }
      await page.keyboard.press('Escape');
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await trigger.getByText('Кнопки · 1', { exact: true }).waitFor({ state: 'visible' });
      await previewButton.waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-buttons-error',
    beforeShot: async (page) => {
      const { sheet } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      const url = sheet.locator('input[type="url"]').first();
      await url.fill('max.ru/publik');
      await sheet.getByRole('button', { name: 'Готово', exact: true }).click();
      await sheet.waitFor({ state: 'visible' });
      if ((await url.getAttribute('aria-invalid')) !== 'true') {
        throw new Error('Publisher button URL error is not exposed through aria-invalid.');
      }
      if (
        (await sheet
          .getByLabel('Название', { exact: true })
          .first()
          .getAttribute('aria-invalid')) === 'true'
      ) {
        throw new Error('Publisher button URL error incorrectly marks the name field invalid.');
      }
      const describedBy = (await url.getAttribute('aria-describedby'))?.trim();
      if (!describedBy) {
        throw new Error('Publisher button URL error is not associated through aria-describedby.');
      }
      const associatedAlertVisible = await sheet.locator('[role="alert"]').evaluateAll(
        (alerts, ids) =>
          alerts.some((alert) => {
            const style = getComputedStyle(alert);
            const rect = alert.getBoundingClientRect();
            return (
              ids.includes(alert.id) &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0
            );
          }),
        describedBy.split(/\s+/u),
      );
      if (!associatedAlertVisible) {
        throw new Error('Publisher button URL error does not point to a visible alert.');
      }
    },
  },
  {
    name: PUBLISHER_BUTTONS_KEYBOARD_SCENARIO,
    beforeShot: async (page) => {
      const { sheet } = await openPublisherButtonsSheet(page);
      await assertPublisherButtonsSheetIsDirect(sheet);
      await sheet.getByLabel('Название', { exact: true }).first().fill('Подробнее');
    },
  },
  {
    name: 'publications-publisher-import-buttons-omitted',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      const notice = page.locator('.publication-import-buttons-notice');
      await notice.waitFor({ state: 'visible' });
      await notice.getByText('Кнопки не перенесены', { exact: true }).waitFor({ state: 'visible' });
      await notice.getByRole('button', { name: 'Добавить', exact: true }).click();
      const sheet = page.locator('.publication-buttons-sheet');
      await sheet.waitFor({ state: 'visible' });
      await assertPublisherButtonsSheetIsDirect(sheet);
      await assertPublisherButtonsSheetHasDefaultButton(sheet, 'import recovery open');
      await page.keyboard.press('Escape');
      await waitForPublisherButtonsSheetClosed(page, sheet);
      await notice.waitFor({ state: 'visible' });
      await notice.getByText('Кнопки не перенесены', { exact: true }).waitFor({ state: 'visible' });
      await notice.getByRole('button', { name: 'Добавить', exact: true }).waitFor({
        state: 'visible',
      });
    },
  },
  {
    name: 'publications-publisher-compose-large',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page.locator('.publication-target-picker__summary').click();
      const loadMore = page.locator('.publication-target-picker__load-more');
      await loadMore.waitFor({ state: 'visible' });
      await loadMore.click();
      await page.getByText('60 из 200', { exact: true }).waitFor({ state: 'visible' });
      await loadMore.click();
      await page.getByText('90 из 200', { exact: true }).waitFor({ state: 'visible' });
      const list = page.locator('.publication-target-picker__list.is-virtual');
      await list.waitFor({ state: 'visible' });
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        element.dispatchEvent(new Event('scroll'));
      });
      await page.locator('.publication-target-row').last().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-selected',
    beforeShot: async (page) => {
      const summary = page.locator('.publication-target-picker__summary');
      await summary.click();
      await page.locator('.publication-target-row').first().click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      await summary.getByText('Садоводы Южного', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-long',
    beforeShot: async (page) => {
      const summary = page.locator('.publication-target-picker__summary');
      await summary.click();
      await page.locator('.publication-target-row').first().click();
      await page.getByRole('button', { name: 'Завершить выбор получателей' }).click();
      const editor = page.locator('.publication-content-composer .max-rich-text-editor__surface');
      await editor.fill(
        Array.from(
          { length: 14 },
          (_, index) => `Абзац ${index + 1}. Текст длинной публикации для проверки прокрутки.`,
        ).join('\n\n'),
      );
      const viewport = page.locator('.publications-editor');
      await viewport.evaluate((element) => element.scrollTo({ top: element.scrollHeight }));
      await viewport.locator('.publications-publish-bar').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-unready-target',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .getByText('Получатель из ссылки пока не готов к публикации через Публик', {
          exact: true,
        })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-publisher-compose-missing-target',
    beforeShot: async (page) => {
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .getByText('Получатель из ссылки недоступен.', { exact: true })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-publisher-policy-setup',
    beforeShot: async (page) => {
      const card = page.locator('.publisher-policy-card');
      await card.waitFor({ state: 'visible' });
      await card.scrollIntoViewIfNeeded();
      if ((await card.getByRole('checkbox').count()) !== 1) {
        throw new Error('Major must expose exactly one compact Publik toggle.');
      }
      if ((await card.getByRole('button').count()) !== 0) {
        throw new Error('Publik readiness actions leaked into the Major overview.');
      }
    },
  },
  {
    name: 'chat-settings-publisher-policy-error',
    beforeShot: async (page) => {
      const card = page.locator('.publisher-policy-card');
      await card.waitFor({ state: 'visible' });
      await card.scrollIntoViewIfNeeded();
      await card
        .getByRole('checkbox', { name: 'Настройка Публика недоступна' })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-publisher-policy',
    beforeShot: async (page) => {
      const card = page.locator('.publisher-policy-card');
      await card.waitFor({ state: 'visible' });
      await card.scrollIntoViewIfNeeded();
      if ((await card.getByRole('checkbox').count()) !== 1) {
        throw new Error('Channel settings must expose one Publik toggle.');
      }
    },
  },
  {
    name: 'publications-actions',
    beforeShot: async (page) => {
      await page.locator('.publications-page').waitFor({ state: 'visible' });
      await page.locator('.publication-feed-card__menu-trigger').first().click();
      await page.locator('.publication-action-menu__panel').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-edit-discard',
    beforeShot: async (page) => {
      await page.locator('.publication-feed-card__surface').first().click();
      await page.locator('.publication-details-sheet__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Отметить неотправленной/u }).click();
      await page
        .getByRole('dialog', { name: 'Сообщение не отправлено?' })
        .getByRole('button', { name: 'Подтвердить' })
        .click();
      await page.getByRole('button', { name: 'Повторить запуск' }).waitFor({ state: 'visible' });
      await page.locator('.publication-details-sheet__header > button').click();
      await page.getByText('Есть недоставленные сообщения').waitFor({ state: 'visible' });
      await page.locator('.publication-feed-card__menu-trigger').first().click();
      await page.getByRole('button', { name: 'Изменить версию для повтора' }).click();
      await page.locator('.publications-editor').waitFor({ state: 'visible' });
      await page
        .locator('.broadcast-publish-bar__primary:not(:disabled)')
        .waitFor({ state: 'visible' });
      await page.locator('.publication-target-picker__summary').click();
      await page.locator('.publication-target-row[aria-pressed="true"]').first().click();
      await page.getByRole('button', { name: 'Назад' }).click();
      await page
        .getByRole('dialog', { name: 'Закрыть без сохранения?' })
        .waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-retry-choice',
    beforeShot: async (page) => {
      await page.locator('.publication-feed-card__surface').first().click();
      await page.locator('.publication-details-sheet__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /Отметить неотправленной/u }).click();
      await page
        .getByRole('dialog', { name: 'Сообщение не отправлено?' })
        .getByRole('button', { name: 'Подтвердить' })
        .click();
      await page.getByRole('button', { name: 'Повторить запуск' }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Повторить запуск' }).click();
      await page.getByRole('dialog', { name: 'Версия для повтора' }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publications-legacy',
    beforeShot: async (page) => {
      const firstLegacyRow = page.locator('.legacy-publications-row').first();
      await firstLegacyRow.waitFor({ state: 'visible' });
      await firstLegacyRow.scrollIntoViewIfNeeded();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'publications-compose',
    beforeShot: async (page) => {
      await page.locator('.publications-page').waitFor({ state: 'visible' });
      await page.waitForFunction(() => {
        const params = new URLSearchParams(window.location.search);
        return !params.has('compose') && !params.has('entityType') && !params.has('entityId');
      });
      if ((await page.locator('.publications-editor').count()) !== 0) {
        throw new Error('Major entered the Publisher-only publication editor.');
      }
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'events-moderation',
    beforeShot: waitForModerationEventsReady,
  },
  {
    name: 'events-moderation-scrolled',
    beforeShot: async (page) => {
      await waitForModerationEventsReady(page);
      await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'instant' }));
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'events-moderation-expanded',
    beforeShot: async (page) => {
      await waitForModerationEventsReady(page);
      await page.locator('.event-feed-item__trigger').first().click();
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'events-activity',
    beforeShot: waitForActivityEventsReady,
  },
  {
    name: 'events-participants',
    beforeShot: async (page) => {
      await page.locator('.participants-roster').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-participant-sheet',
    beforeShot: async (page) => {
      const firstParticipant = page.locator('.participants-roster__item--interactive').first();
      await firstParticipant.waitFor({ state: 'visible' });
      await firstParticipant.click();
      await page.locator('.participant-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-participant-controls',
    beforeShot: async (page) => {
      const manageableParticipant = page
        .locator('.participants-roster__item--interactive')
        .filter({ hasText: '@sergey-market' })
        .first();
      await manageableParticipant.waitFor({ state: 'visible' });
      await manageableParticipant.click();
      await page.locator('.participant-sheet').waitFor({ state: 'visible' });
      await page.locator('.participant-sheet__action--immunity').click();
      await page.locator('#participant-sheet-immunity-composer').waitFor({ state: 'visible' });
      await scrollSettingsDrilldownToBottom(page);
    },
  },
  {
    name: 'events-spam-review',
    beforeShot: async (page) => {
      await page.locator('.spammer-review__entry').click();
      await page.locator('.spammer-review-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'events-spam-diagnostics',
    beforeShot: async (page) => {
      await page.locator('.spammer-review__entry').click();
      const firstCandidate = page.locator('.spammer-review-sheet__row').first();
      await firstCandidate.waitFor({ state: 'visible' });
      await firstCandidate.click();
      await page.locator('.spammer-diagnostics-sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings',
  },
  {
    name: 'chat-settings-access-lost',
    beforeShot: async (page) => {
      await page.locator('.managed-access-alert').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-rules',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Правила', '.settings-drilldown__panel--rules');
    },
  },
  {
    name: 'chat-settings-greeting',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Приветствие', '.settings-drilldown__panel--greeting');
    },
  },
  {
    name: 'chat-settings-profanity',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Мат и оскорбления', '.settings-drilldown__panel--profanity');
    },
  },
  {
    name: 'chat-settings-commercial',
    beforeShot: async (page) => {
      await openSettingsSection(
        page,
        'Коммерческая реклама',
        '.settings-drilldown__panel--commercial',
      );
    },
  },
  {
    name: 'chat-settings-duplicates',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
    },
  },
  {
    name: 'chat-settings-duplicates-photos',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      await panel.getByLabel('Включить проверку повторных фото').check();
      await panel.getByRole('radiogroup', { name: 'Где искать повторное фото' }).waitFor({
        state: 'visible',
      });
      await panel.getByRole('radio', { name: 'С изменениями' }).click();
      await panel.getByRole('radio', { name: 'Во всём чате' }).click();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'chat-settings-duplicates-duration',
    beforeShot: async (page) => {
      const panel = page.locator('.settings-drilldown__panel--duplicates');
      await openSettingsSection(page, 'Антидубль', '.settings-drilldown__panel--duplicates');
      await panel.locator('.settings-duration-editor__preset--trigger').click();
      await panel.locator('.settings-duration-editor').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-limits',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ограничения', '.settings-drilldown__panel--limits');
    },
  },
  {
    name: 'chat-settings-night',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ночной режим', '.settings-drilldown__panel--night');
    },
  },
  {
    name: 'chat-settings-night-time-picker',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Ночной режим', '.settings-drilldown__panel--night');
      const timeField = page
        .locator('.settings-drilldown__panel--night .time-field__button')
        .first();
      await timeField.scrollIntoViewIfNeeded();
      await timeField.click();
      await page.locator('.time-field-sheet__panel').waitFor({ state: 'visible' });
      const lastMinute = page.locator(
        '.time-field-sheet__option[data-time-part="minute"][data-time-value="59"]',
      );
      await lastMinute.scrollIntoViewIfNeeded();
      await lastMinute.click();
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'chat-settings-commands',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Команды', '.settings-drilldown__panel--commands');
    },
  },
  {
    name: 'chat-settings-storefront',
    beforeShot: async (page) => {
      await page.getByRole('checkbox', { name: 'Включить кнопку витрины Караван' }).waitFor({
        state: 'visible',
      });
    },
  },
  {
    name: 'chat-settings-extra',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Сообщения и боты', '.settings-drilldown__panel--extra');
    },
  },
  {
    name: 'chat-settings-speech-style',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: 'Стиль речи', exact: true }).click();
      await page.locator('.settings-drilldown__panel--speech').waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'chat-settings-stop-words',
    beforeShot: async (page) => {
      await page.locator('.settings-word-banlist__preset-grid').waitFor({ state: 'visible' });
      await page.locator('.settings-word-banlist').scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-links',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-bot-message-editor',
    beforeShot: async (page) => {
      await page.locator('.settings-drilldown__panel--links').waitFor({ state: 'visible' });
      const explanationToggle = page.getByLabel('Включить объяснение для модерации ссылок');
      if (!(await explanationToggle.isChecked())) {
        await explanationToggle.check();
      }
      await page
        .getByRole('button', { name: 'Редактировать текст сообщения о ссылках', exact: true })
        .click();
      await page.locator('.bot-message-editor-sheet__panel').waitFor({ state: 'visible' });
      await assertBotMessagePlaceholderRoundTrip(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-links-timer',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.locator('.allowlist-item__action--schedule').first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'chat-settings-links-button-picker',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.getByLabel('Включить объяснение для модерации ссылок').check();
      await page.waitForTimeout(250);
      const buttonToggle = page.getByLabel('Добавить кнопку в сообщение бота для модерации ссылок');
      await buttonToggle.scrollIntoViewIfNeeded();
      await buttonToggle.check();
      await page.waitForTimeout(450);
      const editor = page.locator('.broadcast-link-editor').first();
      await editor.waitFor({ state: 'visible' });
      await page.evaluate(() => {
        document.querySelector('.broadcast-link-editor')?.scrollIntoView({
          block: 'start',
          behavior: 'instant',
        });
        window.scrollBy({ top: -84, behavior: 'instant' });
      });
      await page
        .locator('.broadcast-link-editor input[type="url"]')
        .first()
        .fill('https://max.ru/');
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-links-button-sheet',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.getByLabel('Включить объяснение для модерации ссылок').check();
      await page.waitForTimeout(250);
      const buttonToggle = page.getByLabel('Добавить кнопку в сообщение бота для модерации ссылок');
      await buttonToggle.scrollIntoViewIfNeeded();
      await buttonToggle.check();
      await page.waitForTimeout(450);
      const editor = page.locator('.broadcast-link-editor').first();
      await editor.waitFor({ state: 'visible' });
      await editor.scrollIntoViewIfNeeded();
      await page.locator('.broadcast-link-editor input[type="text"]').first().fill('Открыть канал');
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-polls',
    beforeShot: async (page) => {
      await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-poll-editor',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-poll-published',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await publishPreviewPoll(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-poll-draft',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page);
      await savePreviewPollDraft(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-giveaway',
    beforeShot: async (page) => {
      await page.locator('.managed-giveaway--dashboard').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-editor',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
    },
  },
  {
    name: 'chat-settings-giveaway-conditions-step',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-channels-modal',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
      await page
        .getByRole('button', {
          name: /(?:Открыть список|Добавить свой канал|Выбрано)/u,
        })
        .click();
      await page.locator('.managed-giveaway-modal__sheet').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-giveaway-publish-step',
    beforeShot: async (page) => {
      await openPreviewGiveawayEditor(page);
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.locator('.managed-giveaway--step-conditions').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: /(?:Далее: призы|К призам)/u }).click();
      await page.locator('.managed-giveaway--step-prizes').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-dialog-comments',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-dialog-comments-short-thread',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await assertCommentsComposerPinned(page);
    },
  },
  {
    name: 'chat-dialog-comments-empty-thread',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-comments',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-suggest',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'publisher-entity-modules-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Постинг', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'publisher-channel-modules-cold',
    beforeShot: async (page) => {
      await page.locator('.publisher-entity-modules-page').waitFor({ state: 'visible' });
      await page.getByText('Предложки', { exact: true }).waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-required-subscription',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-apply-target',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      const explanationToggle = page.getByLabel('Включить объяснение для модерации ссылок');
      if (!(await explanationToggle.isChecked())) {
        await explanationToggle.check();
      }
      await page.getByRole('button', { name: /Применить к другим чатам/u }).click();
      await page.locator('.settings-apply-target__panel').waitFor({ state: 'visible' });
      await page.getByRole('button', { name: 'Категории', exact: true }).click();
      const categories = page.getByRole('group', { name: 'Категории избранного' });
      await categories.waitFor({ state: 'visible' });
      const categoryGrid = await categories.evaluate((element) => {
        const buttons = Array.from(element.querySelectorAll('button'));
        return {
          buttonCount: buttons.length,
          selectedCount: buttons.filter((button) => button.getAttribute('aria-pressed') === 'true')
            .length,
          columnCount: getComputedStyle(element).gridTemplateColumns.split(/\s+/u).filter(Boolean)
            .length,
        };
      });
      if (
        categoryGrid.buttonCount !== 6 ||
        categoryGrid.selectedCount !== 6 ||
        categoryGrid.columnCount !== 2
      ) {
        throw new Error(
          `Apply-target category grid is incomplete: ${JSON.stringify(categoryGrid)}.`,
        );
      }
    },
  },
  {
    name: 'chat-settings-broadcast',
    beforeShot: async (page) => {
      await page.locator('.managed-autopost-rule-card').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-broadcast-handoff',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'chat-settings-broadcast-audience',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
      await page.locator('.broadcast-audience-card__mode-tabs').getByRole('radio').nth(1).click();
      await page.locator('.broadcast-audience-sheet__panel').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-broadcast-history',
    beforeShot: async (page) => {
      await openBroadcastHistoryTab(page);
    },
  },
  {
    name: 'chat-settings-broadcast-editor',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings',
  },
  {
    name: 'channel-settings-post-signature',
    beforeShot: async (page) => {
      const signatureEntry = page.getByRole('button', {
        name: 'Подпись публикаций',
        exact: true,
      });
      if ((await signatureEntry.getAttribute('aria-expanded')) !== 'false') {
        throw new Error('Channel post signature editor is expanded on the overview.');
      }
      if ((await page.getByRole('textbox', { name: 'Текст ссылки' }).count()) !== 0) {
        throw new Error('Channel post signature fields leaked into the overview.');
      }
      await openSettingsSection(
        page,
        'Подпись публикаций',
        '.settings-drilldown__panel--signature',
      );
      if ((await signatureEntry.getAttribute('aria-expanded')) !== 'true') {
        throw new Error('Channel post signature entry did not expose its open state.');
      }
      const signatureToggle = page.getByRole('checkbox', { name: 'Подпись публикаций' });
      await signatureToggle.check();
      const signatureText = page.getByRole('textbox', { name: 'Текст ссылки' });
      await signatureText.fill('Читать канал');
      await signatureText.blur();
      const signatureUrl = page.getByRole('textbox', { name: 'Адрес ссылки' });
      await signatureUrl.fill('https://max.ru/advertising-manager');
      await signatureUrl.blur();
      await page.getByText('Сохранено', { exact: true }).waitFor({ state: 'visible' });
      const previewHref = await page
        .locator('.channel-post-signature__preview a')
        .getAttribute('href');
      if (previewHref !== 'https://max.ru/advertising-manager') {
        throw new Error(`Channel post signature preview kept an outdated URL: ${previewHref}.`);
      }
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'channel-settings-access-degraded',
    beforeShot: async (page) => {
      await page.locator('.managed-access-alert').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-comments',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /(?:Комментарии|Обсуждение)/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-post-suggestions',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Предложения/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-post-suggestions-off',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Предложения/u }).click();
      const toggle = page.getByRole('checkbox', { name: 'Принимать предложения', exact: true });
      if (await toggle.isChecked()) {
        await toggle.uncheck();
      }
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-polls',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Опросы/u }).click();
      await page.locator('.managed-poll-workspace').waitFor({ state: 'visible' });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-settings-poll-editor',
    beforeShot: async (page) => {
      await openPreviewPollEditor(page, { openSection: true });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-settings-giveaway',
    beforeShot: async (page) => {
      await openSettingsSection(page, 'Розыгрыши', '.settings-drilldown__panel--channel-giveaway');
    },
  },
  {
    name: 'channel-settings-broadcast',
    beforeShot: async (page) => {
      await page.locator('.managed-autopost-rule-card').first().waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-broadcast-handoff',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-settings-broadcast-history',
    beforeShot: async (page) => {
      await openBroadcastHistoryTab(page);
    },
  },
  {
    name: 'channel-settings-broadcast-editor',
    beforeShot: async (page) => {
      await page.locator('.broadcast-compose-flow').waitFor({ state: 'visible' });
    },
  },
  {
    name: 'channel-stats',
    beforeShot: waitForChannelStatsReady,
  },
  {
    name: 'channel-stats-24h',
    beforeShot: async (page) => {
      await page
        .locator(
          '.channel-insights__chart-controls .channel-insights__range .segmented-control__item',
        )
        .filter({ hasText: /24ч/u })
        .click();
      await page.locator('.channel-stats-graph--continuous').first().waitFor({ state: 'visible' });
      await assertChannelStatsContinuousChart(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-top-posts',
    beforeShot: async (page) => {
      const detailTarget = page
        .locator('.channel-top-posts-panel, .channel-summary-table-card')
        .first();
      await detailTarget.evaluate((element) => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        window.scrollBy({ top: -116, behavior: 'instant' });
      });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-events',
    beforeShot: waitForChannelEventsReady,
  },
  {
    name: 'legal-agreement',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'legal-privacy',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'init-missing',
    beforeShot: async (page) => {
      await page.locator('.init-missing-card').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'giveaway-default',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-blocked',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      try {
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 2_500 });
      } catch {
        await page.getByRole('button', { name: /Участвовать/u }).click();
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 3_000 });
      }
    },
  },
  {
    name: 'giveaway-joined',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      try {
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 2_500 });
      } catch {
        await page.getByRole('button', { name: /Участвовать/u }).click();
        await page.locator('#giveaway-overlay-title').waitFor({ state: 'visible', timeout: 3_000 });
      }
    },
  },
  {
    name: 'giveaway-winner',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-completed',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
];

const scenarioBehaviorByName = new Map(
  scenarioBehaviors.map((behavior) => [behavior.name, behavior]),
);

for (const sourceName of MINIAPP_VISUAL_BOTTOM_SCENARIO_SOURCES) {
  const source = scenarioBehaviorByName.get(sourceName);
  if (!source) {
    throw new Error(`Missing source scenario behavior for bottom screenshot: ${sourceName}`);
  }
  scenarioBehaviorByName.set(`${sourceName}-bottom`, {
    name: `${sourceName}-bottom`,
    beforeShot: async (page) => {
      if (source.beforeShot) {
        await source.beforeShot(page);
      }
      if (sourceName === 'publisher-entity-modules-vk') {
        await setScrollPosition(page.locator('html'), 'bottom', 'Publisher module page');
      } else {
        await scrollSettingsDrilldownToBottom(page);
      }
    },
  });
}

const favoriteCategoriesBehavior = scenarioBehaviorByName.get('home-favorite-categories');
if (!favoriteCategoriesBehavior) {
  throw new Error('Missing source scenario behavior: home-favorite-categories');
}
scenarioBehaviorByName.set('home-favorite-categories-bottom', {
  name: 'home-favorite-categories-bottom',
  beforeShot: async (page) => {
    await favoriteCategoriesBehavior.beforeShot?.(page);
    await setScrollPosition(
      page.locator('.favorite-picker:visible .favorite-picker__panel').first(),
      'bottom',
      'Favorite categories',
    );
  },
});

const metadataNames = new Set(MINIAPP_VISUAL_SCENARIOS.map((scenario) => scenario.name));
const missingScenarioMetadata = [...scenarioBehaviorByName.keys()].filter(
  (name) => !metadataNames.has(name),
);
if (missingScenarioMetadata.length > 0) {
  throw new Error(`Missing visual scenario metadata: ${missingScenarioMetadata.join(', ')}`);
}

const scenarios = MINIAPP_VISUAL_SCENARIOS.map((metadata) => ({
  ...metadata,
  ...scenarioBehaviorByName.get(metadata.name),
}));
const scenarioByName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));

const changedFiles = resolveChangedVisualFiles();
const scenarioSelection = selectMiniappVisualScenarios({
  scenarioNames: process.env.MINIAPP_SCREENSHOT_SCENARIOS,
  changedFiles,
  preset: visualPresetName,
});
const activeScenarios = scenarioSelection.scenarios.map((scenario) =>
  scenarioByName.get(scenario.name),
);

if (activeScenarios.length === 0) {
  const detail =
    scenarioSelection.reason === 'changed-files'
      ? ` for changed files: ${scenarioSelection.changedFiles.join(', ')}`
      : '';
  throw new Error(`Visual scenario selection is empty${detail}.`);
}

function resolveChangedVisualFiles() {
  const explicitFiles = (process.env.MINIAPP_SCREENSHOT_CHANGED_FILES ?? '')
    .split(/[\n,]/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (explicitFiles.length > 0 || !parseEnvFlag('MINIAPP_SCREENSHOT_CHANGED')) {
    return explicitFiles;
  }

  try {
    const tracked = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACMRD', 'HEAD', '--'],
      { cwd: ROOT_DIR, encoding: 'utf8' },
    );
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT_DIR,
      encoding: 'utf8',
    });
    return [...new Set(`${tracked}\n${untracked}`.split('\n').map((value) => value.trim()))].filter(
      Boolean,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve changed files for visual selection: ${message}`);
  }
}

async function assertCommentsComposerPinned(page) {
  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.channel-dialog-shell');
    const compose = document.querySelector('.channel-dialog-compose');

    if (!(shell instanceof HTMLElement) || !(compose instanceof HTMLElement)) {
      return null;
    }

    const shellRect = shell.getBoundingClientRect();
    const composeRect = compose.getBoundingClientRect();

    return {
      shellBottom: shellRect.bottom,
      composeBottom: composeRect.bottom,
      delta: Math.abs(shellRect.bottom - composeRect.bottom),
    };
  });

  if (!layout) {
    throw new Error('Comments dialog layout nodes were not found for anchor check.');
  }

  if (layout.delta > 2) {
    throw new Error(
      `Comments composer is not pinned to the viewport bottom (delta=${layout.delta.toFixed(2)}).`,
    );
  }
}

async function assertCommentsTopEdgeCovered(page) {
  if (screenshotTarget !== 'native') {
    return;
  }

  const layout = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell--comments-dialog');
    const screen = document.querySelector('.channel-dialog-screen--comments');
    const backdrop = document.querySelector('.channel-dialog-screen__backdrop');

    if (
      !(shell instanceof HTMLElement) ||
      !(screen instanceof HTMLElement) ||
      !(backdrop instanceof HTMLElement)
    ) {
      return null;
    }

    const shellRect = shell.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const backdropRect = backdrop.getBoundingClientRect();
    const shellStyle = getComputedStyle(shell);
    const screenStyle = getComputedStyle(screen);

    return {
      shellTop: shellRect.top,
      screenTop: screenRect.top,
      backdropTop: backdropRect.top,
      shellPaddingTop: Number.parseFloat(shellStyle.paddingTop) || 0,
      screenPaddingTop: Number.parseFloat(screenStyle.paddingTop) || 0,
    };
  });

  if (!layout) {
    throw new Error('Comments dialog layout nodes were not found for top edge check.');
  }

  const topGap = Math.max(layout.shellTop, layout.screenTop, layout.backdropTop);
  if (topGap > 0.5 || layout.shellPaddingTop > 0.5 || layout.screenPaddingTop > 0.5) {
    throw new Error(
      [
        'Comments dialog top edge is not covered',
        `(shellTop=${layout.shellTop.toFixed(2)},`,
        `screenTop=${layout.screenTop.toFixed(2)},`,
        `backdropTop=${layout.backdropTop.toFixed(2)},`,
        `shellPaddingTop=${layout.shellPaddingTop.toFixed(2)},`,
        `screenPaddingTop=${layout.screenPaddingTop.toFixed(2)})`,
      ].join(' '),
    );
  }
}

async function assertCommentsContentTopInset(page) {
  if (screenshotTarget !== 'native') {
    return;
  }

  const layout = await page.evaluate(() => {
    const list = document.querySelector('.channel-dialog-message-list');
    const firstContent =
      list?.querySelector('.channel-dialog-message, .channel-dialog-empty') ?? null;

    if (!(list instanceof HTMLElement) || !(firstContent instanceof HTMLElement)) {
      return null;
    }

    const listRect = list.getBoundingClientRect();
    const firstContentRect = firstContent.getBoundingClientRect();
    const listStyle = getComputedStyle(list);

    return {
      inset: firstContentRect.top - listRect.top,
      listPaddingTop: Number.parseFloat(listStyle.paddingTop) || 0,
    };
  });

  if (!layout) {
    throw new Error('Comments content nodes were not found for top inset check.');
  }

  if (layout.inset < 6 || layout.listPaddingTop < 6) {
    throw new Error(
      [
        'Comments content is too close to the top edge',
        `(inset=${layout.inset.toFixed(2)},`,
        `listPaddingTop=${layout.listPaddingTop.toFixed(2)})`,
      ].join(' '),
    );
  }
}

async function openBroadcastHistoryTab(page) {
  await page.waitForTimeout(900);
  const historyTab = page
    .locator('.broadcast-studio-shell__tabs')
    .getByRole('radio', { name: /^История/u })
    .first();
  await historyTab.waitFor({ state: 'visible', timeout: 10_000 });
  await historyTab.click();
  await historyTab.waitFor({ state: 'visible' });
  await page.waitForFunction(
    (selector) => document.querySelector(selector)?.getAttribute('aria-checked') === 'true',
    '.broadcast-studio-shell__tabs [data-segmented-value="history"]',
  );
  await page.locator('.broadcast-history-filters').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
}

function buildPreviewUrl(baseUrl, routePath, queryDevice, scenarioSearchParams = {}, options = {}) {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const normalizedRoutePath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const url = new URL(base.toString());

  url.pathname = `${normalizedBasePath}${normalizedRoutePath}`;
  if (options.preview !== false) {
    url.searchParams.set('preview', '1');
    url.searchParams.set('device', queryDevice);
  }
  for (const [key, value] of Object.entries(scenarioSearchParams)) {
    if (value != null && String(value).trim()) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function waitForApp(page, scenario) {
  if (scenario.preview === false) {
    await page.waitForSelector(scenario.readySelector ?? '.app-shell', { timeout: 20_000 });
    await page.waitForTimeout(500);
    return;
  }

  await page.waitForSelector('.design-preview__device', { timeout: 20_000 });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  if (scenario.readySelector) {
    await page.waitForSelector(scenario.readySelector, { timeout: 20_000 });
  }
  await page.waitForTimeout(500);
}

async function runScenarioNavigation(page, scenario, baseUrl, profile, runtime) {
  const visited = [scenario.path];
  for (const [index, step] of (scenario.navigation ?? []).entries()) {
    const url = new URL(
      buildPreviewUrl(baseUrl, step.path, profile.queryDevice, step.searchParams, {
        preview: runtime.previewEnabled,
      }),
    );
    await page.evaluate(
      ({ pathname, search, hash, stateKey }) => {
        const previousState = window.history.state;
        const previousIndex =
          previousState && typeof previousState.idx === 'number' ? previousState.idx : 0;
        const state = {
          ...(previousState && typeof previousState === 'object' ? previousState : {}),
          idx: previousIndex + 1,
          key: stateKey,
        };
        window.history.pushState(state, '', `${pathname}${search}${hash}`);
        window.dispatchEvent(new PopStateEvent('popstate', { state }));
      },
      {
        pathname: url.pathname,
        search: url.search,
        hash: url.hash,
        stateKey: `visual-${scenario.name}-${index}`,
      },
    );
    await page.waitForFunction(
      ({ pathname, search }) =>
        window.location.pathname === pathname && window.location.search === search,
      { pathname: url.pathname, search: url.search },
    );
    await page.waitForSelector(step.readySelector, { state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(350);
    visited.push(step.path);
  }
  return visited;
}

async function applyNativeScreenshotMode(page, profile) {
  if (screenshotTarget !== 'native') {
    return;
  }

  const state = await applyNativeVisualMode(page, profile);
  if (state?.hadPreviewScaffold && !state.previewScaffoldDetached) {
    throw new Error('Native screenshot mode did not detach the design-preview geometry.');
  }
}

async function assertMaxBridgeAbsent(page, scenario) {
  const hasBridge = await page.evaluate(() => Boolean(window.MAX?.WebApp ?? window.WebApp));
  if (hasBridge) {
    throw new Error(`Scenario ${scenario.name} must run without a MAX Bridge.`);
  }
}

async function assertFocusedLocator(locator, label) {
  const focused = await locator.evaluate((element) => element === document.activeElement);
  if (!focused) {
    throw new Error(`${label} did not receive keyboard focus.`);
  }
}

async function readLocatorViewportMetrics(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  });
}

function assertViewportMetrics(metrics, label) {
  if (
    metrics.left < -2 ||
    metrics.right > metrics.viewportWidth + 2 ||
    metrics.top < -2 ||
    metrics.bottom > metrics.viewportHeight + 2
  ) {
    throw new Error(
      `${label} is outside the simulated keyboard viewport: ` +
        `left=${metrics.left.toFixed(1)} right=${metrics.right.toFixed(1)} ` +
        `top=${metrics.top.toFixed(1)} bottom=${metrics.bottom.toFixed(1)} ` +
        `viewport=${metrics.viewportWidth}x${metrics.viewportHeight}.`,
    );
  }
}

async function assertLocatorWithinViewport(locator, label) {
  const metrics = await readLocatorViewportMetrics(locator);
  assertViewportMetrics(metrics, label);
  return metrics;
}

async function exercisePublisherComposerKeyboardFlow(page) {
  const picker = page.locator('.publication-target-picker');
  const summary = picker.locator('.publication-target-picker__summary');
  const sheet = page.locator('.publication-target-picker__editor.is-sheet');
  const search = sheet.locator('input[type="search"]');
  const done = sheet.getByRole('button', { name: 'Завершить выбор получателей' });

  await sheet.waitFor({ state: 'visible' });
  await search.focus();
  await assertFocusedLocator(search, 'Publisher recipient search');
  await assertLocatorWithinViewport(search, 'Publisher recipient search');
  await assertLocatorWithinViewport(done, 'Publisher recipient Done button');

  await done.click();
  await sheet.waitFor({ state: 'detached' });
  await page.waitForTimeout(50);
  await assertFocusedLocator(summary, 'Publisher recipient summary after closing');

  await summary.click();
  await sheet.waitFor({ state: 'visible' });
  await search.focus();
  await assertFocusedLocator(search, 'Publisher recipient search after reopening');
  await assertLocatorWithinViewport(search, 'Publisher recipient search after reopening');

  await done.click();
  await sheet.waitFor({ state: 'detached' });
  await page.waitForTimeout(50);
  await assertFocusedLocator(summary, 'Publisher recipient summary after second close');

  const editor = page
    .locator('.publication-content-composer .max-rich-text-editor__surface')
    .first();
  await editor.waitFor({ state: 'visible' });
  await editor.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await editor.focus();
  await assertFocusedLocator(editor, 'Publisher rich-text editor');
  await assertLocatorWithinViewport(editor, 'Publisher rich-text editor');
}

async function exercisePublisherAutoReplyEditorKeyboardFlow(page) {
  const editor = page.locator('.publisher-auto-reply-editor');
  await editor.waitFor({ state: 'visible' });
  const textEditor = editor.getByRole('textbox', {
    name: 'Текст автоответа',
    exact: true,
  });
  await textEditor.waitFor({ state: 'visible' });
  await textEditor.evaluate((element) =>
    element.scrollIntoView({ block: 'center', behavior: 'instant' }),
  );
  await textEditor.focus();
  await assertFocusedLocator(textEditor, 'Auto-reply text editor');
  await assertLocatorWithinViewport(textEditor, 'Auto-reply text editor');
}

async function exercisePublisherButtonsKeyboardFlow(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  await sheet.waitFor({ state: 'visible' });
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const done = sheet.getByRole('button', { name: 'Готово', exact: true });
  await name.waitFor({ state: 'visible' });
  await url.waitFor({ state: 'visible' });
  await name.evaluate((element) =>
    element.scrollIntoView({ block: 'nearest', behavior: 'instant' }),
  );
  await name.focus();
  await assertFocusedLocator(name, 'Publisher button name');
  await assertLocatorWithinViewport(name, 'Publisher button name');
  await assertLocatorWithinViewport(url, 'Publisher button URL');
  await assertLocatorWithinViewport(done, 'Publisher button Done action');
}

async function exercisePublisherButtonsReducedKeyboardFlow(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  const trigger = page
    .locator('.publication-content-composer')
    .getByRole('button', { name: /кнопк/iu })
    .first();
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();

  await name.focus();
  await assertFocusedLocator(name, 'Publisher button name before focus handoff');
  await url.focus();
  await assertFocusedLocator(url, 'Publisher button URL after focus handoff');
  await page.waitForFunction(() =>
    document.querySelector('.publications-page.is-editor')?.classList.contains('is-keyboard-open'),
  );

  await page.keyboard.press('Escape');
  await waitForPublisherButtonsSheetClosed(page, sheet);
  await assertFocusedLocator(trigger, 'Publisher button trigger after keyboard close');
  await page.waitForFunction(() =>
    document.querySelector('.publications-page.is-editor')?.classList.contains('is-keyboard-open'),
  );

  await trigger.click();
  await sheet.waitFor({ state: 'visible' });
  const reopenedName = sheet.getByLabel('Название', { exact: true }).first();
  const reopenedUrl = sheet.getByLabel('Ссылка', { exact: true }).first();
  await reopenedName.waitFor({ state: 'visible' });
  await reopenedUrl.waitFor({ state: 'visible' });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await reopenedName.focus();
  await assertFocusedLocator(reopenedName, 'Publisher button name after keyboard reopening');
  await reopenedUrl.focus();
  await assertFocusedLocator(reopenedUrl, 'Publisher button URL after keyboard reopening');
}

async function assertPublisherButtonsKeyboardFinalLayout(page) {
  const sheet = page.locator('.publication-buttons-sheet');
  const name = sheet.getByLabel('Название', { exact: true }).first();
  const url = sheet.getByLabel('Ссылка', { exact: true }).first();
  const done = sheet.getByRole('button', { name: 'Готово', exact: true });
  const nameMetrics = await assertLocatorWithinViewport(name, 'Publisher button name after reflow');
  const urlMetrics = await assertLocatorWithinViewport(url, 'Publisher button URL after reflow');
  const doneMetrics = await readLocatorViewportMetrics(done);
  const frame = await sheet.evaluate((element) => {
    const panel = element.querySelector('.publication-buttons-sheet__panel');
    const footer = element.querySelector('.publication-buttons-sheet__footer');
    const toRect = (target) => {
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      const rect = target.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const rootStyle = getComputedStyle(document.documentElement);
    const sheetStyle = getComputedStyle(element);
    const panelStyle = panel instanceof HTMLElement ? getComputedStyle(panel) : null;
    return {
      keyboardOpen: document.documentElement.dataset.maxKeyboardOpen === 'true',
      appViewportHeight: rootStyle.getPropertyValue('--app-viewport-height').trim(),
      visualViewportTop: rootStyle.getPropertyValue('--app-visual-viewport-top').trim(),
      sheet: toRect(element),
      panel: toRect(panel),
      footer: toRect(footer),
      sheetHeight: sheetStyle.height,
      sheetPadding: sheetStyle.padding,
      sheetAlignItems: sheetStyle.alignItems,
      panelHeight: panelStyle?.height ?? null,
      panelMarginTop: panelStyle?.marginTop ?? null,
    };
  });
  const bottomClearance = doneMetrics.viewportHeight - doneMetrics.bottom;
  if (bottomClearance < 8) {
    throw new Error(
      'Publisher button Done action is clipped or flush with the keyboard viewport ' +
        `(bottom=${doneMetrics.bottom.toFixed(1)}, viewport=${doneMetrics.viewportHeight}, ` +
        `clearance=${bottomClearance.toFixed(1)}px, frame=${JSON.stringify(frame)}).`,
    );
  }
  assertViewportMetrics(doneMetrics, 'Publisher button Done action after reflow');
  return {
    nameTop: nameMetrics.top,
    urlBottom: urlMetrics.bottom,
    doneBottom: doneMetrics.bottom,
    bottomClearance,
    frame,
  };
}

async function simulateKeyboardViewport(page, scenario) {
  if (!shouldSimulateKeyboardScenario(scenario)) {
    return null;
  }

  const keyboardProfile = resolveKeyboardScenarioProfile(scenario);

  await page.addStyleTag({
    content: `
      html[data-max-keyboard-open='true'] .bottom-nav {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate(-50%, calc(100% + var(--space-6, 32px) + var(--app-keyboard-overlap, 0px))) !important;
      }
    `,
  });

  const viewport = page.viewportSize();
  if (!viewport) {
    throw new Error(`Scenario ${scenario.name} has no viewport geometry for keyboard simulation.`);
  }
  const maximumReducedHeight = viewport.height - KEYBOARD_MIN_REDUCTION_PX;
  const orientationSafeMinimumHeight = Math.max(
    KEYBOARD_MIN_VISIBLE_HEIGHT_PX,
    viewport.height > viewport.width ? viewport.width + 1 : 0,
  );
  if (orientationSafeMinimumHeight > maximumReducedHeight) {
    throw new Error(
      `Scenario ${scenario.name} cannot preserve viewport orientation while simulating a keyboard ` +
        `in ${viewport.width}x${viewport.height}.`,
    );
  }
  const reducedHeight = Math.min(
    maximumReducedHeight,
    Math.max(orientationSafeMinimumHeight, viewport.height - normalizedKeyboardOverlapPx),
  );
  if (reducedHeight <= 0 || reducedHeight >= viewport.height) {
    throw new Error(
      `Scenario ${scenario.name} cannot reduce viewport ${viewport.width}x${viewport.height} ` +
        `for keyboard overlap ${normalizedKeyboardOverlapPx}px.`,
    );
  }

  if (keyboardProfile?.flow === 'publisher-composer') {
    await exercisePublisherComposerKeyboardFlow(page);
  } else if (keyboardProfile?.flow === 'publisher-buttons') {
    await exercisePublisherButtonsKeyboardFlow(page);
  } else if (keyboardProfile?.flow === 'publisher-auto-reply-editor') {
    await exercisePublisherAutoReplyEditorKeyboardFlow(page);
  }

  const cycles = keyboardProfile?.flow === 'publisher-composer' ? 3 : 1;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await page.setViewportSize({ width: viewport.width, height: reducedHeight });
    await page.waitForFunction(
      (expectedHeight) => Math.abs(window.innerHeight - expectedHeight) <= 1,
      reducedHeight,
    );
    await page.waitForTimeout(180);
    if (cycle === 0 && keyboardProfile?.flow === 'publisher-buttons') {
      await exercisePublisherButtonsReducedKeyboardFlow(page);
    }
    if (keyboardProfile?.focusSelector) {
      await page
        .locator(keyboardProfile.focusSelector)
        .first()
        .evaluate((element) => {
          element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        });
    }
    if (cycle < cycles - 1) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForFunction(
        (expectedHeight) => Math.abs(window.innerHeight - expectedHeight) <= 1,
        viewport.height,
      );
      await page.waitForTimeout(180);
      if (keyboardProfile?.focusSelector) {
        await assertFocusedLocator(
          page.locator(keyboardProfile.focusSelector).first(),
          `${keyboardProfile.focusLabel} after keyboard cycle ${cycle + 1}`,
        );
      }
      if (keyboardProfile?.flow === 'publisher-composer') {
        await page.waitForFunction(
          () =>
            !document
              .querySelector('.publications-page.is-editor')
              ?.classList.contains('is-keyboard-open'),
        );
        const actionDisplay = await page
          .locator('.publications-editor > .publications-publish-bar')
          .evaluate((element) => getComputedStyle(element).display);
        if (actionDisplay === 'none') {
          throw new Error(`Publisher action did not return after keyboard cycle ${cycle + 1}.`);
        }
      }
    }
  }

  await page.evaluate(
    ({ forceKeyboardFlag, originalHeight, viewportHeight }) => {
      const root = document.documentElement;
      if (forceKeyboardFlag) {
        root.setAttribute('data-max-keyboard-open', 'true');
      } else {
        root.removeAttribute('data-max-keyboard-open');
      }
      root.dataset.visualKeyboardOriginalHeight = String(originalHeight);
      root.dataset.visualKeyboardViewportHeight = String(viewportHeight);
    },
    {
      forceKeyboardFlag: keyboardProfile?.flow === 'publisher-auto-reply-editor',
      originalHeight: viewport.height,
      viewportHeight: reducedHeight,
    },
  );
  await page.waitForTimeout(260);

  const controls =
    keyboardProfile?.flow === 'publisher-buttons'
      ? await assertPublisherButtonsKeyboardFinalLayout(page)
      : null;

  return {
    originalHeight: viewport.height,
    viewportHeight: reducedHeight,
    coveredHeight: viewport.height - reducedHeight,
    cycles,
    focus: keyboardProfile?.focusReport ?? null,
    ...(controls ? { controls } : {}),
  };
}

async function assertConfiguredChecks(page, scenario) {
  if (strictLayout) {
    await assertAppHasVisibleContent(page, scenario);
    await assertViewportBounds(page, scenario);
    await assertNoUnexpectedHorizontalOverflow(page, scenario);
    await assertPublisherEditorFullBleed(page, scenario);
    await assertPublisherComposerActionInFlow(page, scenario);
    await assertVkSourceSummariesSeparated(page, scenario);
    await assertFavoriteCategoryIndicatorsContained(page, scenario);
    await assertPrimaryControlsReachable(page, scenario);
    await assertTimeFieldOptionsReachable(page, scenario);
    await assertChartsPainted(page, scenario);
    await assertKeyboardState(page, scenario);
  }

  if (strictContrast) {
    await assertCriticalContrast(page, scenario);
    await assertSettingsDrilldownScrollContrast(page, scenario);
  }

  if (strictAccessibility) {
    await assertCriticalAccessibility(page, scenario);
    await assertPublicationTouchTargets(page, scenario);
  }
}

async function assertPublisherEditorFullBleed(page, scenario) {
  if (!scenario.name.startsWith('publications-publisher-compose')) {
    return;
  }

  const result = await page.evaluate(() => {
    const shell = document.querySelector('.app-shell:has(.publications-page.is-editor)');
    const pageRoot = document.querySelector('.publications-page.is-publisher.is-editor');
    const header = pageRoot?.querySelector('.publications-editor-header');
    if (
      !(shell instanceof HTMLElement) ||
      !(pageRoot instanceof HTMLElement) ||
      !(header instanceof HTMLElement)
    ) {
      return { ok: false, reason: 'publisher editor shell is missing' };
    }

    const shellStyle = getComputedStyle(shell);
    const pageRect = pageRoot.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const tolerance = 2;
    if (
      Math.abs(pageRect.left) > tolerance ||
      Math.abs(pageRect.right - window.innerWidth) > tolerance ||
      Math.abs(pageRect.top) > tolerance ||
      Math.abs(headerRect.top) > tolerance
    ) {
      return {
        ok: false,
        reason:
          `editor is inset (page=${pageRect.left.toFixed(1)},${pageRect.top.toFixed(1)},` +
          `${pageRect.right.toFixed(1)} headerTop=${headerRect.top.toFixed(1)} ` +
          `viewport=${window.innerWidth}x${window.innerHeight})`,
      };
    }
    if (
      Number.parseFloat(shellStyle.paddingTop) > tolerance ||
      Number.parseFloat(shellStyle.paddingLeft) > tolerance ||
      Number.parseFloat(shellStyle.paddingRight) > tolerance
    ) {
      return {
        ok: false,
        reason: `shell keeps padding ${shellStyle.padding}`,
      };
    }
    return { ok: true, reason: '' };
  });

  if (!result.ok) {
    throw new Error(`Publisher editor full-bleed layout failed: ${result.reason}.`);
  }
}

async function assertPublisherComposerActionInFlow(page, scenario) {
  if (
    !scenario.name.startsWith('publications-publisher-compose') ||
    shouldSimulateKeyboardScenario(scenario)
  ) {
    return;
  }

  const result = await page.evaluate(
    (requireNoScroll) => {
      const editor = document.querySelector('.publications-page.is-editor > .publications-editor');
      const dock = editor?.querySelector(':scope > .publications-publish-bar');
      if (!(editor instanceof HTMLElement) || !(dock instanceof HTMLElement)) {
        return { ok: false, reason: 'editor or in-flow action is missing' };
      }

      const dockRect = dock.getBoundingClientRect();
      const dockStyle = getComputedStyle(dock);
      const previous = dock.previousElementSibling;
      const previousRect =
        previous instanceof HTMLElement ? previous.getBoundingClientRect() : null;
      const previewScreen = document.querySelector('.design-preview__device-screen');
      const viewportBottom =
        previewScreen instanceof HTMLElement
          ? previewScreen.getBoundingClientRect().bottom
          : window.innerHeight;
      if (dockStyle.position !== 'static') {
        return { ok: false, reason: `action uses overlay position ${dockStyle.position}` };
      }
      if (previousRect && previousRect.bottom > dockRect.top + 1) {
        return {
          ok: false,
          reason: `content bottom ${previousRect.bottom.toFixed(1)} crosses action top ${dockRect.top.toFixed(1)}`,
        };
      }
      if (editor.scrollHeight <= editor.clientHeight + 2 && dockRect.bottom > viewportBottom + 2) {
        return {
          ok: false,
          reason: `in-flow action bottom ${dockRect.bottom.toFixed(1)} leaves non-scrolling viewport ${viewportBottom.toFixed(1)}`,
        };
      }
      if (requireNoScroll && editor.scrollHeight > editor.clientHeight + 2) {
        return {
          ok: false,
          reason:
            `default editor scrolls despite a tall viewport ` +
            `(scroll=${editor.scrollHeight}, client=${editor.clientHeight})`,
        };
      }
      if (requireNoScroll && viewportBottom - dockRect.bottom > 16) {
        return {
          ok: false,
          reason: `default editor leaves ${Math.round(viewportBottom - dockRect.bottom)}px unused below action`,
        };
      }
      return { ok: true, reason: '' };
    },
    scenario.name === 'publications-publisher-compose-selected' &&
      (page.viewportSize()?.height ?? 0) >= 800,
  );

  if (!result.ok) {
    throw new Error(`Publisher composer action layout failed: ${result.reason}.`);
  }
}

async function assertVkSourceSummariesSeparated(page, scenario) {
  if (!scenario.name.startsWith('publisher-entity-modules-vk')) {
    return;
  }

  const issues = await page.evaluate(() => {
    const tolerance = 0.5;
    const overlaps = (left, right) =>
      Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance &&
      Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance;
    const isContained = (inner, outer) =>
      inner.left >= outer.left - tolerance &&
      inner.top >= outer.top - tolerance &&
      inner.right <= outer.right + tolerance &&
      inner.bottom <= outer.bottom + tolerance;

    return Array.from(
      document.querySelectorAll('.publisher-entity-vk-module .vk-source-card'),
    ).flatMap((card, cardIndex) => {
      if (!(card instanceof HTMLElement)) {
        return [];
      }

      const summary = card.querySelector('.vk-source-card__summary-row');
      const mode = summary?.querySelector('.vk-source-mode-control');
      const metrics = summary?.querySelector('.vk-source-card__metrics');
      if (
        !(summary instanceof HTMLElement) ||
        !(mode instanceof HTMLElement) ||
        !(metrics instanceof HTMLElement)
      ) {
        return [{ cardIndex, reason: 'summary controls are missing' }];
      }

      const summaryRect = summary.getBoundingClientRect();
      const modeRect = mode.getBoundingClientRect();
      const metricsRect = metrics.getBoundingClientRect();
      const controls = [...mode.children, ...metrics.children].filter(
        (element) => element instanceof HTMLElement,
      );
      const textNodes = [
        ...mode.querySelectorAll('button'),
        ...metrics.querySelectorAll('b, small'),
      ];
      const title = card.querySelector('.vk-source-card__title strong')?.textContent?.trim() ?? '';

      if (!isContained(modeRect, summaryRect) || !isContained(metricsRect, summaryRect)) {
        return [{ cardIndex, title, reason: 'summary group leaves its row' }];
      }

      if (overlaps(modeRect, metricsRect)) {
        return [{ cardIndex, title, reason: 'mode and metrics overlap' }];
      }

      for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
        const left = controls[leftIndex];
        if (!(left instanceof HTMLElement)) {
          continue;
        }
        for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
          const right = controls[rightIndex];
          if (
            right instanceof HTMLElement &&
            overlaps(left.getBoundingClientRect(), right.getBoundingClientRect())
          ) {
            return [{ cardIndex, title, reason: 'summary controls overlap' }];
          }
        }
      }

      const clippedText = textNodes.find(
        (element) =>
          element instanceof HTMLElement && element.scrollWidth > element.clientWidth + 1,
      );
      if (clippedText instanceof HTMLElement) {
        return [
          {
            cardIndex,
            title,
            reason: `summary text is clipped: ${clippedText.textContent?.trim() ?? ''}`,
          },
        ];
      }

      if (card.clientWidth <= 432 && modeRect.bottom > metricsRect.top + tolerance) {
        return [{ cardIndex, title, reason: 'narrow summary is not vertically separated' }];
      }

      return [];
    });
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an invalid VK source summary at card ${first.cardIndex}` +
        `${first.title ? ` (${first.title})` : ''}: ${first.reason}.`,
    );
  }
}

async function assertFavoriteCategoryIndicatorsContained(page, scenario) {
  const issues = await page.evaluate(() => {
    const tolerance = 0.5;
    const isContained = (inner, outer) =>
      inner.left >= outer.left - tolerance &&
      inner.top >= outer.top - tolerance &&
      inner.right <= outer.right + tolerance &&
      inner.bottom <= outer.bottom + tolerance;

    return Array.from(document.querySelectorAll('.chat-card__favorite-mark.has-category')).flatMap(
      (badge, index) => {
        if (!(badge instanceof HTMLElement)) {
          return [];
        }

        const action = badge.closest('.chat-card__action--favorite');
        const star = badge.querySelector(':scope > .chat-card__favorite-star');
        const category = badge.querySelector(':scope > .chat-card__favorite-category-icon');
        const statistics = action?.nextElementSibling;
        if (
          !(action instanceof HTMLElement) ||
          !(star instanceof SVGElement) ||
          !(category instanceof SVGElement)
        ) {
          return [{ index, reason: 'missing action or compound mark icon' }];
        }

        const actionRect = action.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();
        const starRect = star.getBoundingClientRect();
        const categoryRect = category.getBoundingClientRect();
        const statisticsRect =
          statistics instanceof HTMLElement ? statistics.getBoundingClientRect() : null;
        const iconGap = categoryRect.left - starRect.right;
        const actionGap = statisticsRect ? statisticsRect.left - actionRect.right : null;
        if (
          isContained(badgeRect, actionRect) &&
          isContained(starRect, badgeRect) &&
          isContained(categoryRect, badgeRect) &&
          iconGap >= 1.5 &&
          (actionGap === null || actionGap >= 5.5)
        ) {
          return [];
        }

        return [
          {
            index,
            reason: 'compound mark is clipped, overlapping or too close to statistics',
            action: `${actionRect.width.toFixed(1)}x${actionRect.height.toFixed(1)}`,
            mark: `${badgeRect.width.toFixed(1)}x${badgeRect.height.toFixed(1)}`,
            star: `${starRect.width.toFixed(1)}x${starRect.height.toFixed(1)}`,
            category: `${categoryRect.width.toFixed(1)}x${categoryRect.height.toFixed(1)}`,
            iconGap: iconGap.toFixed(1),
            actionGap: actionGap?.toFixed(1) ?? 'n/a',
          },
        ];
      },
    );
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an invalid favorite category indicator at index ${first.index}: ` +
        `${first.reason}` +
        (first.action
          ? ` (action=${first.action}, mark=${first.mark}, star=${first.star}, category=${first.category}, ` +
            `iconGap=${first.iconGap}, actionGap=${first.actionGap})`
          : ''),
    );
  }
}

async function assertTimeFieldOptionsReachable(page, scenario) {
  const issues = await page.evaluate(async () => {
    const optionLists = Array.from(document.querySelectorAll('.time-field-sheet__options')).filter(
      (element) => element instanceof HTMLElement,
    );

    if (optionLists.length === 0) {
      return [];
    }

    for (const optionList of optionLists) {
      optionList.scrollTop = optionList.scrollHeight;
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });

    const actionsRect = document
      .querySelector('.time-field-sheet__actions')
      ?.getBoundingClientRect();

    return optionLists.flatMap((optionList) => {
      const lastOption = optionList.lastElementChild;
      if (!(lastOption instanceof HTMLElement)) {
        return [{ reason: 'missing-last-option' }];
      }

      const listRect = optionList.getBoundingClientRect();
      const optionRect = lastOption.getBoundingClientRect();
      const reachesScrollEnd =
        Math.abs(optionList.scrollTop - (optionList.scrollHeight - optionList.clientHeight)) <= 1;
      const insideList = optionRect.bottom <= listRect.bottom + 1;
      const clearOfActions = !actionsRect || optionRect.bottom <= actionsRect.top + 1;

      return reachesScrollEnd && insideList && clearOfActions
        ? []
        : [
            {
              reason: 'last-option-obscured',
              scrollTop: optionList.scrollTop,
              maxScrollTop: optionList.scrollHeight - optionList.clientHeight,
              optionBottom: optionRect.bottom,
              listBottom: listRect.bottom,
              actionsTop: actionsRect?.top ?? null,
            },
          ];
    });
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has an unreachable final time option: ${JSON.stringify(first)}.`,
    );
  }
}

async function assertSettingsDrilldownScrollContrast(page, scenario) {
  if (!strictContrast) {
    return;
  }

  const scrollTargets = [
    {
      label: 'favorite picker',
      locator: page.locator('.favorite-picker:visible .favorite-picker__panel').first(),
    },
    {
      label: 'settings drilldown',
      locator: page.locator('.settings-drilldown:visible .settings-drilldown__body').first(),
    },
    {
      label: 'bot message editor',
      locator: page
        .locator('.bot-message-editor-sheet:visible .bot-message-editor-sheet__body')
        .first(),
    },
    {
      label: 'broadcast audience',
      locator: page
        .locator('.broadcast-audience-sheet:visible .broadcast-audience-sheet__scroll')
        .first(),
    },
    {
      label: 'giveaway modal',
      locator: page
        .locator('.managed-giveaway-modal:visible .managed-giveaway-modal__sheet')
        .first(),
    },
    {
      label: 'publication actions',
      locator: page.locator('.publication-action-menu:visible .publication-action-menu__actions'),
    },
    {
      label: 'publication details',
      locator: page.locator('.publication-details-sheet:visible .publication-details-sheet__body'),
    },
    {
      label: 'publication retry',
      locator: page.locator('.publication-retry-sheet:visible .publication-retry-sheet__panel'),
    },
  ];

  for (const target of scrollTargets) {
    if ((await target.locator.count()) === 0) {
      continue;
    }
    const initial = await target.locator.evaluate((element) => ({
      clientHeight: element.clientHeight,
      maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
      scrollTop: element.scrollTop,
    }));
    if (initial.maxScrollTop <= 1 || initial.clientHeight <= 1) {
      continue;
    }

    const step = Math.max(1, Math.floor(initial.clientHeight * 0.72));
    const positions = [];
    for (let top = 0; top < initial.maxScrollTop; top += step) {
      positions.push(top);
    }
    positions.push(initial.maxScrollTop);

    try {
      for (const top of positions) {
        await setScrollPosition(target.locator, top, target.label);
        await assertCriticalContrast(page, {
          ...scenario,
          name: `${scenario.name} at ${target.label} scroll ${top}/${initial.maxScrollTop}`,
        });
      }
    } finally {
      await setScrollPosition(target.locator, initial.scrollTop, target.label);
    }
  }
}

async function assertCriticalContrast(page, scenario) {
  if (!strictContrast) {
    return;
  }

  const issues = await page.evaluate(() => {
    const scopeSelectors = [
      '.publications-page',
      '.publication-details-sheet',
      '.publication-action-menu',
      '.publication-retry-sheet',
      '.chats-page',
      '.chats-home',
      '.favorite-picker',
      '.settings-sections',
      '.channel-settings-screen',
      '.channel-settings-card',
      '.settings-drilldown',
      '.settings-apply-target',
      '.bot-message-editor-sheet',
      '.broadcast-audience-sheet',
      '.managed-poll-workspace',
      '.events-screen',
      '.membership-activity-feed',
      '.chat-participants-roster',
      '.participant-sheet',
      '.spammer-review-sheet',
      '.spammer-diagnostics-sheet',
      '.channel-stats-page',
    ];

    const parseColor = (value) => {
      const match = value
        .trim()
        .match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/iu);
      if (!match) {
        return null;
      }
      return {
        red: Number(match[1]),
        green: Number(match[2]),
        blue: Number(match[3]),
        alpha: match[4] == null ? 1 : Number(match[4]),
      };
    };
    const composite = (foreground, background) => {
      const alpha = Math.max(0, Math.min(1, foreground.alpha));
      return {
        red: foreground.red * alpha + background.red * (1 - alpha),
        green: foreground.green * alpha + background.green * (1 - alpha),
        blue: foreground.blue * alpha + background.blue * (1 - alpha),
        alpha: 1,
      };
    };
    const luminance = (color) => {
      const linearize = (channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
      };
      return (
        0.2126 * linearize(color.red) +
        0.7152 * linearize(color.green) +
        0.0722 * linearize(color.blue)
      );
    };
    const contrast = (foreground, background) => {
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      const light = Math.max(foregroundLuminance, backgroundLuminance);
      const dark = Math.min(foregroundLuminance, backgroundLuminance);
      return (light + 0.05) / (dark + 0.05);
    };
    const firstBackgroundImageColor = (value) => {
      if (!value || value === 'none') {
        return null;
      }
      const match = value.match(/rgba?\([^)]*\)/iu);
      return match ? parseColor(match[0]) : null;
    };
    const effectiveBackground = (element) => {
      const lineage = [];
      let current = element;
      while (current instanceof HTMLElement) {
        lineage.unshift(current);
        current = current.parentElement;
      }
      let result = { red: 255, green: 255, blue: 255, alpha: 1 };
      for (const node of lineage) {
        const style = getComputedStyle(node);
        const backgroundColor = parseColor(style.backgroundColor);
        if (backgroundColor && backgroundColor.alpha > 0.01) {
          result = composite(backgroundColor, result);
        }
        const imageColor = firstBackgroundImageColor(style.backgroundImage);
        if (imageColor && imageColor.alpha > 0.01) {
          result = composite(imageColor, result);
        }
      }
      return result;
    };
    const hasDirectText = (element) =>
      Array.from(element.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
      );
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };

    const roots = scopeSelectors.flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)),
    );
    const candidates = Array.from(
      new Set(roots.flatMap((root) => [root, ...root.querySelectorAll('*')])),
    ).filter(
      (element) =>
        element instanceof HTMLElement &&
        hasDirectText(element) &&
        isVisible(element) &&
        !element.closest('[disabled], [aria-disabled="true"], [aria-hidden="true"]'),
    );

    return candidates
      .flatMap((element) => {
        const style = getComputedStyle(element);
        const foreground = parseColor(style.color);
        if (!foreground || foreground.alpha <= 0.05) {
          return [];
        }
        const background = effectiveBackground(element);
        const renderedForeground = composite(foreground, background);
        const ratio = contrast(renderedForeground, background);
        const fontSize = Number.parseFloat(style.fontSize) || 16;
        const fontWeight = Number.parseInt(style.fontWeight, 10) || 400;
        const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
        const requiredRatio = isLarge ? 3 : 4.5;
        if (ratio + 0.05 >= requiredRatio) {
          return [];
        }
        return [
          {
            tagName: element.tagName,
            className: element.className?.toString() ?? '',
            text: element.innerText.replace(/\s+/gu, ' ').trim().slice(0, 80),
            ratio,
            requiredRatio,
          },
        ];
      })
      .slice(0, 5);
  });

  if (issues.length > 0) {
    const summary = issues
      .map(
        (issue) =>
          `${issue.tagName}.${issue.className}: ${issue.ratio.toFixed(2)} < ` +
          `${issue.requiredRatio.toFixed(1)} ("${issue.text}")`,
      )
      .join('; ');
    throw new Error(`Scenario ${scenario.name} has insufficient text contrast at ${summary}.`);
  }
}

async function assertCriticalAccessibility(page, scenario) {
  if (!strictAccessibility) {
    return;
  }

  const issues = await page.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };
    const accessibleName = (element) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/u)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ');
        if (label) {
          return label;
        }
      }
      const ariaLabel = element.getAttribute('aria-label')?.trim();
      if (ariaLabel) {
        return ariaLabel;
      }
      if (element instanceof HTMLInputElement && element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent?.trim()) {
          return label.textContent.trim();
        }
      }
      if (element.closest('label')?.textContent?.trim()) {
        return element.closest('label').textContent.trim();
      }
      if (
        element instanceof HTMLElement &&
        element.matches('button, summary, a[href], [role="button"], [role="tab"], [role="switch"]')
      ) {
        return element.textContent?.trim() ?? '';
      }
      return '';
    };
    const problems = [];

    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (dialog instanceof HTMLElement && isVisible(dialog) && !accessibleName(dialog)) {
        problems.push({ type: 'unnamed dialog', target: dialog.className || dialog.id });
      }
    }

    for (const control of document.querySelectorAll(
      'button, summary, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="switch"]',
    )) {
      if (!(control instanceof HTMLElement) || !isVisible(control)) {
        continue;
      }
      if (!accessibleName(control)) {
        problems.push({ type: 'unnamed control', target: control.className || control.id });
      }
    }

    return problems.slice(0, 5);
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has accessibility issue: ${first.type} (${first.target}).`,
    );
  }
}

async function assertPublicationTouchTargets(page, scenario) {
  if (!strictAccessibility) {
    return;
  }

  const issues = await page.evaluate(() => {
    if (!document.querySelector('.publications-page')) {
      return [];
    }

    const selectors = [
      '.publications-page .publications-tabs button',
      '.publications-page .publications-filterbar button',
      '.publications-page .publications-filterbar select',
      '.publications-page .publications-load-more',
      '.publications-page .publication-retained-media button',
      '.publications-page .publications-inline-notice button',
      '.publications-page .publications-calendar-error button',
      '.publications-page .publication-target-chip button',
      '.publications-page .publication-weekdays button',
      '.publications-page .publication-recurrence__times > div > button',
      '.publications-page .publication-content-composer .broadcast-content-composer__tool',
      '.publications-page .publication-content-composer .broadcast-content-composer__button-label',
      '.publications-page .publication-content-composer .broadcast-content-composer__modifier',
      '.publications-page .publication-content-composer .broadcast-message-card__media-remove',
      '.publications-page .broadcast-publish-bar__issue',
      '.legacy-publications-tabs button',
      '.legacy-publications-filterbar button',
      '.legacy-publications-filterbar select',
      '.publication-action-menu button',
      '.publication-details-sheet button',
      '.publication-retry-sheet button',
      '.action-confirm-sheet button',
      '.toast__close',
      '.broadcast-buttons-sheet__close',
      '.broadcast-buttons-sheet__empty-action',
      '.publication-buttons-sheet button',
      '.publication-buttons-sheet input',
    ];
    const controls = Array.from(
      new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))),
    );
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number.parseFloat(style.opacity || '1') > 0.05
      );
    };

    return controls
      .flatMap((element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) {
          return [];
        }
        const rect = element.getBoundingClientRect();
        if (rect.width + 0.5 >= 44 && rect.height + 0.5 >= 44) {
          return [];
        }
        return [
          {
            target: element.className?.toString() || element.tagName,
            width: rect.width,
            height: rect.height,
          },
        ];
      })
      .slice(0, 5);
  });

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has a publication touch target below 44px: ` +
        `${first.target} (${first.width.toFixed(1)}x${first.height.toFixed(1)}).`,
    );
  }
}

async function assertAppHasVisibleContent(page, scenario) {
  const content = await page.evaluate(() => {
    const root =
      document.querySelector('.design-preview__device-screen') ??
      document.querySelector('.app-shell') ??
      document.body;
    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const visibleText = root.innerText.replace(/\s+/gu, ' ').trim();
    const visibleElements = Array.from(
      root.querySelectorAll('button, a, input, textarea, canvas, svg, img, [role="button"]'),
    ).filter((element) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 1 &&
        rect.height > 1 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number.parseFloat(style.opacity || '1') > 0.01
      );
    }).length;

    return {
      textLength: visibleText.length,
      visibleElements,
    };
  });

  if (!content || (content.textLength < 20 && content.visibleElements < 3)) {
    throw new Error(
      `Scenario ${scenario.name} looks blank (text=${content?.textLength ?? 0}, elements=${
        content?.visibleElements ?? 0
      }).`,
    );
  }
}

async function assertViewportBounds(page, scenario) {
  const issues = await page.evaluate((keyboardMode) => {
    const previewScreen = document.querySelector('.design-preview__device-screen');
    const previewRect =
      previewScreen instanceof HTMLElement ? previewScreen.getBoundingClientRect() : null;
    const hasPreviewBounds = Boolean(
      previewRect && previewRect.width > 1 && previewRect.height > 1,
    );
    const viewportLeft = hasPreviewBounds ? previewRect.left : 0;
    const viewportTop = hasPreviewBounds ? previewRect.top : 0;
    const viewportRight = hasPreviewBounds ? previewRect.right : window.innerWidth;
    const viewportBottom = hasPreviewBounds ? previewRect.bottom : window.innerHeight;
    const viewportWidth = viewportRight - viewportLeft;
    const viewportHeight = viewportBottom - viewportTop;
    const selectors = [
      '.app-shell:not(.app-shell--immersive)',
      keyboardMode ? null : '.bottom-nav:not(.is-keyboard-open)',
      '.shell-topbar',
      '.settings-drilldown',
      '.broadcast-buttons-sheet__panel',
      '.broadcast-planner-sheet__panel',
      '.time-field-sheet',
      '.channel-dialog-screen',
      '.channel-dialog-compose__surface',
      '.giveaway-page__overlay-card',
      '.init-missing-card',
    ];

    return selectors.filter(Boolean).flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).flatMap((element) => {
        if (!(element instanceof HTMLElement)) {
          return [];
        }
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.01
        ) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        const allowScrolledTop =
          selector === '.app-shell:not(.app-shell--immersive)' ||
          (style.position !== 'fixed' && style.position !== 'sticky');
        const topTolerance = selector === '.channel-dialog-screen' ? 12 : 2;
        const problem =
          rect.left < viewportLeft - 2 ||
          rect.right > viewportRight + 2 ||
          (!allowScrolledTop && rect.top < viewportTop - topTolerance) ||
          rect.top > viewportBottom + 2;
        return problem
          ? [
              {
                selector,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                viewportWidth,
                viewportHeight,
              },
            ]
          : [];
      }),
    );
  }, shouldSimulateKeyboardScenario(scenario));

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has viewport-bound issue at ${first.selector}: ` +
        `left=${first.left.toFixed(1)} right=${first.right.toFixed(1)} top=${first.top.toFixed(
          1,
        )} viewport=${first.viewportWidth}x${first.viewportHeight}.`,
    );
  }
}

async function assertNoUnexpectedHorizontalOverflow(page, scenario) {
  const overflow = await page.evaluate(() => {
    const root =
      document.querySelector('.design-preview__device-screen') ??
      document.querySelector('.app-shell') ??
      document.documentElement;
    if (!(root instanceof HTMLElement)) {
      return null;
    }

    const allowedOverflowSelectors = [
      '.broadcast-planner',
      '.channel-stats-graph',
      '.channel-insights',
      '.channel-dialog-messages',
      '.vk-parsing-feed',
      '.settings-drilldown',
      '[data-allow-horizontal-overflow]',
    ];

    const rootOverflow = root.scrollWidth - root.clientWidth;
    const offenders = Array.from(root.querySelectorAll('*')).flatMap((element) => {
      if (!(element instanceof HTMLElement)) {
        return [];
      }
      if (allowedOverflowSelectors.some((selector) => element.closest(selector))) {
        return [];
      }

      const style = getComputedStyle(element);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity || '1') <= 0.01
      ) {
        return [];
      }

      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) {
        return [];
      }

      const rootRect = root.getBoundingClientRect();
      const overflowLeft = rootRect.left - rect.left;
      const overflowRight = rect.right - rootRect.right;
      if (overflowLeft > 3 || overflowRight > 3) {
        return [
          {
            className: element.className?.toString() ?? element.tagName,
            tagName: element.tagName,
            overflowLeft,
            overflowRight,
          },
        ];
      }

      return [];
    });

    return {
      rootOverflow,
      offenders: offenders.slice(0, 3),
    };
  });

  if (!overflow) {
    return;
  }

  if (overflow.rootOverflow > 4 || overflow.offenders.length > 0) {
    const first = overflow.offenders[0];
    throw new Error(
      `Scenario ${scenario.name} has horizontal overflow: root=${overflow.rootOverflow}px` +
        (first
          ? `, first=${first.tagName}.${first.className} left=${first.overflowLeft.toFixed(
              1,
            )} right=${first.overflowRight.toFixed(1)}`
          : ''),
    );
  }
}

async function assertPrimaryControlsReachable(page, scenario) {
  const issues = await page.evaluate((keyboardMode) => {
    const previewScreen = document.querySelector('.design-preview__device-screen');
    const previewRect =
      previewScreen instanceof HTMLElement ? previewScreen.getBoundingClientRect() : null;
    const hasPreviewBounds = Boolean(
      previewRect && previewRect.width > 1 && previewRect.height > 1,
    );
    const viewportBottom = hasPreviewBounds ? previewRect.bottom : window.innerHeight;
    const viewportHeight = hasPreviewBounds ? previewRect.height : window.innerHeight;
    const hasActiveOverlay = Boolean(
      document.querySelector(
        '.broadcast-buttons-sheet__panel, .broadcast-planner-sheet__panel, .time-field-sheet, .giveaway-page__overlay-card',
      ),
    );
    const selectors = [
      keyboardMode ? null : '.bottom-nav:not(.is-keyboard-open)',
      '.channel-dialog-compose__surface',
      hasActiveOverlay ? null : '.settings-drilldown__footer',
      '.broadcast-buttons-sheet__panel',
      '.broadcast-planner-sheet__panel',
      '.time-field-sheet',
    ];

    return selectors.filter(Boolean).flatMap((selector) =>
      Array.from(document.querySelectorAll(selector)).flatMap((element) => {
        if (!(element instanceof HTMLElement)) {
          return [];
        }
        const style = getComputedStyle(element);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          Number.parseFloat(style.opacity || '1') <= 0.01
        ) {
          return [];
        }

        const rect = element.getBoundingClientRect();
        return rect.bottom > viewportBottom + 2
          ? [
              {
                selector,
                bottom: rect.bottom,
                viewportHeight,
              },
            ]
          : [];
      }),
    );
  }, shouldSimulateKeyboardScenario(scenario));

  if (issues.length > 0) {
    const first = issues[0];
    throw new Error(
      `Scenario ${scenario.name} has unreachable primary control ${first.selector}: ` +
        `bottom=${first.bottom.toFixed(1)} viewport=${first.viewportHeight}.`,
    );
  }
}

async function assertChartsPainted(page, scenario) {
  if (!scenario.name.includes('stats')) {
    return;
  }

  const painted = await page.evaluate(() => {
    const chart =
      document.querySelector('.channel-stats-graph__bar') ??
      document.querySelector('.channel-stats-graph svg') ??
      document.querySelector('canvas');
    if (
      !(
        chart instanceof HTMLElement ||
        chart instanceof SVGElement ||
        chart instanceof HTMLCanvasElement
      )
    ) {
      return false;
    }

    const rect = chart.getBoundingClientRect();
    if (rect.width <= 2 || rect.height <= 2) {
      return false;
    }

    if (chart instanceof HTMLCanvasElement) {
      const context = chart.getContext('2d');
      if (!context) {
        return false;
      }
      const sampleWidth = Math.min(chart.width, 64);
      const sampleHeight = Math.min(chart.height, 64);
      const data = context.getImageData(0, 0, sampleWidth, sampleHeight).data;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) {
          return true;
        }
      }
      return false;
    }

    return true;
  });

  if (!painted) {
    throw new Error(`Scenario ${scenario.name} did not render a visible chart/graph element.`);
  }
}

async function assertChannelStatsContinuousChart(page) {
  const result = await page.evaluate(() => {
    const chart = document.querySelector('.channel-stats-graph--continuous');
    if (!chart) {
      return { ok: false, reason: 'continuous chart class is missing' };
    }

    const lineDots = chart.querySelectorAll('.channel-stats-graph__dot').length;
    const eventDots = chart.querySelectorAll('.channel-stats-graph__event-dot').length;
    const flowDots = chart.querySelectorAll('.channel-stats-graph__flow-knot').length;
    const labels = chart.querySelectorAll('.channel-stats-graph__labels small').length;
    if (lineDots > 0 || eventDots > 0 || flowDots > 0 || labels > 0) {
      return {
        ok: false,
        reason: `unexpected hourly markers: line=${lineDots}, event=${eventDots}, flow=${flowDots}, labels=${labels}`,
      };
    }

    return { ok: true, reason: '' };
  });

  if (!result.ok) {
    throw new Error(`24h channel stats chart marker assertion failed: ${result.reason}`);
  }
}

async function assertKeyboardState(page, scenario) {
  if (
    !shouldSimulateKeyboardScenario(scenario) ||
    scenario.preview === false ||
    scenario.name.includes('dialog')
  ) {
    return;
  }

  const keyboardProfile = resolveKeyboardScenarioProfile(scenario);
  const requiresRootKeyboardFlag =
    !keyboardProfile || keyboardProfile.flow === 'publisher-auto-reply-editor';
  const state = await page.evaluate((profile) => {
    const root = document.documentElement;
    const nav = document.querySelector('.bottom-nav');
    const navStyle = nav instanceof HTMLElement ? getComputedStyle(nav) : null;
    const active = document.activeElement;
    const activeRect = active instanceof HTMLElement ? active.getBoundingClientRect() : null;
    const publishBar = profile?.actionBarSelector
      ? document.querySelector(profile.actionBarSelector)
      : null;
    const publishBarStyle = publishBar instanceof HTMLElement ? getComputedStyle(publishBar) : null;
    const publishBarVisible = Boolean(
      publishBar instanceof HTMLElement &&
      publishBarStyle &&
      publishBarStyle.display !== 'none' &&
      publishBarStyle.visibility !== 'hidden' &&
      Number.parseFloat(publishBarStyle.opacity || '1') > 0.01,
    );
    const publishBarRect =
      publishBarVisible && publishBar instanceof HTMLElement
        ? publishBar.getBoundingClientRect()
        : null;
    const primary =
      publishBar && profile?.primarySelector
        ? publishBar.querySelector(profile.primarySelector)
        : null;

    return {
      keyboardOpen: root.dataset.maxKeyboardOpen === 'true',
      pageKeyboardOpen: Boolean(
        document.querySelector('.publications-page.is-editor.is-keyboard-open'),
      ),
      originalHeight: Number.parseInt(root.dataset.visualKeyboardOriginalHeight ?? '', 10),
      expectedViewportHeight: Number.parseInt(root.dataset.visualKeyboardViewportHeight ?? '', 10),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      nav:
        nav instanceof HTMLElement && navStyle
          ? {
              opacity: Number.parseFloat(navStyle.opacity || '1'),
              pointerEvents: navStyle.pointerEvents,
            }
          : null,
      activeMatchesPublisherEditor:
        active instanceof HTMLElement &&
        Boolean(profile?.focusSelector) &&
        active.matches(profile.focusSelector),
      activeRect: activeRect
        ? {
            top: activeRect.top,
            bottom: activeRect.bottom,
            left: activeRect.left,
            right: activeRect.right,
          }
        : null,
      publishBarRect: publishBarRect
        ? {
            top: publishBarRect.top,
            bottom: publishBarRect.bottom,
          }
        : null,
      primaryFits:
        primary instanceof HTMLElement
          ? primary.scrollWidth <= primary.clientWidth + 2
          : profile === null,
      pickerSheetOpen: Boolean(
        profile?.pickerSheetSelector && document.querySelector(profile.pickerSheetSelector),
      ),
    };
  }, keyboardProfile);

  if (
    (requiresRootKeyboardFlag && !state.keyboardOpen) ||
    !Number.isFinite(state.originalHeight) ||
    !Number.isFinite(state.expectedViewportHeight) ||
    state.expectedViewportHeight >= state.originalHeight ||
    Math.abs(state.viewportHeight - state.expectedViewportHeight) > 1
  ) {
    throw new Error(
      `Scenario ${scenario.name} did not apply reduced keyboard geometry ` +
        `(keyboardOpen=${state.keyboardOpen}, original=${state.originalHeight}, ` +
        `expected=${state.expectedViewportHeight}, actual=${state.viewportHeight}).`,
    );
  }

  if (state.nav && (state.nav.opacity > 0.05 || state.nav.pointerEvents !== 'none')) {
    throw new Error(
      `Scenario ${scenario.name} keyboard simulation did not hide bottom nav ` +
        `(opacity=${state.nav.opacity}, pointerEvents=${state.nav.pointerEvents}).`,
    );
  }

  if (keyboardProfile?.expectPageKeyboardState && !state.pageKeyboardOpen) {
    throw new Error(`${scenario.name} did not expose its real adjustResize keyboard state.`);
  }

  if (!keyboardProfile) {
    return;
  }

  if (!state.activeMatchesPublisherEditor || !state.activeRect) {
    throw new Error(keyboardProfile.focusFailure);
  }
  if (
    state.activeRect.left < -2 ||
    state.activeRect.right > state.viewportWidth + 2 ||
    state.activeRect.top < -2 ||
    state.activeRect.bottom > state.viewportHeight + 2
  ) {
    throw new Error(
      `${keyboardProfile.focusLabel} is unreachable with keyboard open ` +
        `(top=${state.activeRect.top.toFixed(1)}, bottom=${state.activeRect.bottom.toFixed(1)}, ` +
        `viewport=${state.viewportHeight}).`,
    );
  }
  if (
    state.publishBarRect &&
    ((!keyboardProfile.allowActionBelowViewport &&
      state.publishBarRect.bottom > state.viewportHeight + 2) ||
      (state.publishBarRect.top < state.viewportHeight &&
        state.activeRect.bottom > state.publishBarRect.top + 1))
  ) {
    throw new Error(
      `${keyboardProfile.actionBarLabel} overlaps the focused editor or leaves the keyboard viewport ` +
        `(editorBottom=${state.activeRect.bottom.toFixed(1)}, ` +
        `barTop=${state.publishBarRect.top.toFixed(1)}, ` +
        `barBottom=${state.publishBarRect.bottom.toFixed(1)}, viewport=${state.viewportHeight}).`,
    );
  }
  if (!state.primaryFits) {
    throw new Error(keyboardProfile.primaryFailure);
  }
  if (state.pickerSheetOpen) {
    throw new Error(keyboardProfile.pickerFailure ?? 'Keyboard flow left an overlay open.');
  }
}

function resolveScreenshotLocator(page) {
  if (screenshotTarget === 'native') {
    return null;
  }

  if (screenshotTarget === 'page') {
    return null;
  }

  if (screenshotTarget === 'screen') {
    return page.locator('.design-preview__device-screen');
  }

  return page.locator('.design-preview__device');
}

async function installDeterministicExternalScripts(context) {
  await context.route(/https:\/\/st\.max\.ru\/js\/max-web-app\.js(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/javascript; charset=utf-8',
      body: '/* MAX Bridge is supplied by the visual harness when the scenario enables it. */',
    });
  });
  await context.route(/\/system\/miniapp-boot-trace(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: '{"accepted":true}',
    });
  });
}

function attachPageDiagnostics(page, scenario) {
  const failures = [];

  page.on('pageerror', (error) => {
    failures.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      failures.push(`console.error: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? 'unknown network error';
    failures.push(`requestfailed: ${request.method()} ${request.url()} (${failure})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      failures.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });

  return {
    assertClean() {
      if (failures.length === 0) {
        return;
      }

      throw new Error(
        `Scenario ${scenario.name} emitted browser/network errors:\n${failures
          .slice(0, 8)
          .map((failure) => `- ${failure}`)
          .join('\n')}`,
      );
    },
  };
}

function assertNavigationResponse(response, scenario, url) {
  if (!response) {
    throw new Error(`Scenario ${scenario.name} did not receive an HTTP response for ${url}.`);
  }
  if (response.status() >= 400) {
    throw new Error(
      `Scenario ${scenario.name} navigation failed with HTTP ${response.status()}: ${url}`,
    );
  }
}

async function captureDeviceScenarios(browser, profile, baseUrl, outputDir, report) {
  const device = devices[profile.viewportName];
  if (!device) {
    throw new Error(`Unknown Playwright device profile: ${profile.viewportName}`);
  }

  const shotDir = path.join(outputDir, profile.outputDirName);
  await ensureDir(shotDir);

  for (const scenario of activeScenarios) {
    const startedAt = Date.now();
    const reportEntry = {
      name: scenario.name,
      device: profile.outputDirName,
      routeId: scenario.routeId,
      features: scenario.features,
      tags: scenario.tags,
      cold: scenario.cold,
      navigation: [],
      status: 'running',
    };
    report.scenarios.push(reportEntry);
    const runtime = resolveScenarioRuntime(scenario, maxBridgeShimEnabled);
    let context = null;

    try {
      context = await browser.newContext({
        ...device,
        colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
      });
      await installDeterministicExternalScripts(context);
      if (screenshotTarget === 'native') {
        await installNativeVisualModeInitScript(context);
      }
      if (runtime.bridgeEnabled) {
        await installMaxBridgeShimInitScript(context, profile, {
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
          startParam: process.env.MINIAPP_SCREENSHOT_START_PARAM?.trim() || '',
          version: process.env.MINIAPP_SCREENSHOT_MAX_VERSION?.trim() || '',
        });
      }

      const page = await context.newPage();
      await page.clock.setFixedTime(visualNow);
      const diagnostics = attachPageDiagnostics(page, scenario);
      const url = buildPreviewUrl(
        baseUrl,
        scenario.path,
        profile.queryDevice,
        scenario.searchParams,
        {
          preview: runtime.previewEnabled,
        },
      );
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      assertNavigationResponse(response, scenario, url);
      await waitForApp(page, scenario);
      if (runtime.bridgeEnabled) {
        await assertMaxBridgeShim(page);
      } else if (scenario.maxBridge === false) {
        await assertMaxBridgeAbsent(page, scenario);
      }
      await applyNativeScreenshotMode(page, profile);
      reportEntry.navigation = await runScenarioNavigation(
        page,
        scenario,
        baseUrl,
        profile,
        runtime,
      );

      if (scenario.beforeShot) {
        await scenario.beforeShot(page);
      }

      const keyboardGeometry = await simulateKeyboardViewport(page, scenario);
      if (keyboardGeometry) {
        reportEntry.keyboard = keyboardGeometry;
      }

      if (scenario.name.includes('dialog-comments')) {
        await assertCommentsTopEdgeCovered(page);
        await assertCommentsContentTopInset(page);
      }

      await assertConfiguredChecks(page, scenario);

      if (resolveKeyboardScenarioProfile(scenario)?.flow === 'publisher-buttons') {
        await page.waitForTimeout(220);
        const controls = await assertPublisherButtonsKeyboardFinalLayout(page);
        if (reportEntry.keyboard) {
          reportEntry.keyboard.controls = controls;
        }
      }

      const screenshotPath = path.join(shotDir, `${scenario.name}.png`);
      const locator = resolveScreenshotLocator(page);

      if (locator) {
        await locator.screenshot({
          path: screenshotPath,
          animations: 'disabled',
          timeout: 120_000,
        });
      } else {
        await page.screenshot({
          path: screenshotPath,
          animations: 'disabled',
          timeout: 120_000,
          fullPage: screenshotTarget === 'page',
        });
      }

      diagnostics.assertClean();
      reportEntry.status = 'passed';
      reportEntry.screenshot = path.relative(ROOT_DIR, screenshotPath);
    } catch (error) {
      reportEntry.status = 'failed';
      reportEntry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      reportEntry.durationMs = Date.now() - startedAt;
      await context?.close();
    }
  }
}

async function main() {
  const requestedDevice =
    process.env.MINIAPP_SCREENSHOT_DEVICE?.trim().toLowerCase() ?? visualPreset?.device ?? 'all';
  const baseUrl = resolveMiniappScreenshotBaseUrl();
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  const reportPath = process.env.MINIAPP_SCREENSHOT_REPORT_PATH?.trim()
    ? path.resolve(process.cwd(), process.env.MINIAPP_SCREENSHOT_REPORT_PATH.trim())
    : path.join(outputDir, 'report.json');
  const deviceKeys =
    requestedDevice === 'all'
      ? Object.keys(deviceProfiles)
      : Object.keys(deviceProfiles).filter((key) => key === requestedDevice);

  if (deviceKeys.length === 0) {
    throw new Error('MINIAPP_SCREENSHOT_DEVICE must be one of: android, iphone, iphone-se, all');
  }

  await ensureDir(outputDir);
  await ensureDir(path.dirname(reportPath));

  const report = {
    schemaVersion: 1,
    status: 'running',
    baseUrl,
    source: isLocalMiniappBaseUrl(baseUrl) ? 'local' : 'remote',
    target: screenshotTarget,
    colorScheme,
    fixedNow: visualNow.toISOString(),
    selection: {
      reason: scenarioSelection.reason,
      preset: visualPresetName || null,
      changedFiles: scenarioSelection.changedFiles,
      scenarios: activeScenarios.map((scenario) => scenario.name),
      devices: deviceKeys,
    },
    checks: {
      layout: strictLayout,
      contrast: strictContrast,
      accessibility: strictAccessibility,
    },
    startedAt: new Date().toISOString(),
    scenarios: [],
  };

  let browser = null;
  let devServerProcess = null;
  let reportWritePromise = null;

  const cleanup = async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
    await stopChildProcess(devServerProcess);
    devServerProcess = null;
  };

  const writeReport = () => {
    reportWritePromise ??= (async () => {
      report.finishedAt = new Date().toISOString();
      report.durationMs =
        new Date(report.finishedAt).getTime() - new Date(report.startedAt).getTime();
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    })();
    return reportWritePromise;
  };

  const handleSignal = (signal) => {
    report.status = 'cancelled';
    report.error = `Received ${signal}`;
    void cleanup()
      .finally(writeReport)
      .finally(() => {
        process.exit(signal === 'SIGINT' ? 130 : 143);
      });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    if (isLocalMiniappBaseUrl(baseUrl)) {
      if (reuseServer) {
        await waitForMiniappUrl(baseUrl);
      } else {
        devServerProcess = await ensureMiniappDevServer(baseUrl, { log: console.log });
      }
    }

    console.log(
      `Mini app screenshot source: ${baseUrl} (${isLocalMiniappBaseUrl(baseUrl) ? 'local' : 'explicit remote'})`,
    );

    try {
      browser = await chromium.launch({
        headless: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('error while loading shared libraries')) {
        throw new Error(
          [
            'Playwright Chromium cannot start because system libraries are missing.',
            'Local fallback: install Playwright browser dependencies for your OS.',
            'VPS fallback: run the screenshot flow inside the Playwright Docker image.',
          ].join(' '),
        );
      }

      throw error;
    }

    for (const key of deviceKeys) {
      await captureDeviceScenarios(browser, deviceProfiles[key], baseUrl, outputDir, report);
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanup();
    await writeReport();
  }

  console.log(`Screenshots saved to ${outputDir}`);
  console.log(`Visual report saved to ${reportPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
