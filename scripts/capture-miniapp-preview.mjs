import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import previewDevicePresets from '../apps/miniapp/src/lib/preview-device-presets.json' with { type: 'json' };
import { assertMaxBridgeShim, installMaxBridgeShimInitScript } from './miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from './miniapp-native-visual-mode.mjs';

const DEFAULT_BASE_URL = 'https://major-maksimov.ru/app/';
const OUTPUT_ROOT = path.resolve(process.cwd(), 'artifacts/miniapp-screenshots');
const runLabel = (process.env.MINIAPP_SCREENSHOT_LABEL ?? '').trim();
const timestamp =
  runLabel.replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '') ||
  new Date().toISOString().replace(/[:.]/g, '-');

const deviceProfiles = previewDevicePresets;

const screenshotTarget = (process.env.MINIAPP_SCREENSHOT_TARGET ?? 'device').trim().toLowerCase();
const colorScheme = (process.env.MINIAPP_SCREENSHOT_COLOR_SCHEME ?? 'light').trim().toLowerCase();
const strictLayout = parseEnvFlag('MINIAPP_SCREENSHOT_STRICT_LAYOUT');
const envMaxBridgeShim = parseOptionalEnvFlag('MINIAPP_SCREENSHOT_MAX_BRIDGE');
const maxBridgeShimEnabled = envMaxBridgeShim ?? screenshotTarget === 'native';
const simulateKeyboard = parseEnvFlag('MINIAPP_SCREENSHOT_SIMULATE_KEYBOARD');
const keyboardOverlapPx = Number.parseInt(
  process.env.MINIAPP_SCREENSHOT_KEYBOARD_OVERLAP_PX ?? '320',
  10,
);
const normalizedKeyboardOverlapPx = Number.isFinite(keyboardOverlapPx)
  ? Math.max(160, Math.min(keyboardOverlapPx, 420))
  : 320;

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

const scenarios = [
  {
    name: 'home',
    path: '/',
  },
  {
    name: 'home-channels',
    path: '/',
    searchParams: {
      view: 'channel',
    },
  },
  {
    name: 'events-moderation',
    path: '/chat/preview-chat/events',
  },
  {
    name: 'events-moderation-scrolled',
    path: '/chat/preview-chat/events',
    beforeShot: async (page) => {
      await page.evaluate(() => window.scrollTo({ top: 360, behavior: 'instant' }));
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'events-moderation-expanded',
    path: '/chat/preview-chat/events',
    beforeShot: async (page) => {
      await page.locator('.event-feed-item__trigger').first().click();
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'events-activity',
    path: '/chat/preview-chat/events',
    searchParams: {
      section: 'activity',
    },
  },
  {
    name: 'chat-settings',
    path: '/chat/preview-chat/settings',
  },
  {
    name: 'chat-settings-stop-words',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'stopWords',
    },
    beforeShot: async (page) => {
      await page.locator('.settings-word-banlist__preset-grid').waitFor({ state: 'visible' });
      await page.locator('.settings-word-banlist').scrollIntoViewIfNeeded();
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'chat-settings-links',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'links',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-links-timer',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'links',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await page.locator('.allowlist-item__action--schedule').first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'chat-settings-links-button-picker',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'links',
    },
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
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'links',
    },
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
    name: 'chat-settings-giveaway',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'giveaway',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'chat-settings-giveaway-editor',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'giveaway',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(650);
      const editButton = page.locator('.managed-giveaway').getByRole('button', {
        name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
      });
      if ((await editButton.count()) > 0) {
        await editButton.first().click();
        await page.waitForTimeout(450);
      }
    },
  },
  {
    name: 'chat-settings-giveaway-conditions-step',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'giveaway',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(650);
      const editButton = page.locator('.managed-giveaway').getByRole('button', {
        name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
      });
      if ((await editButton.count()) > 0) {
        await editButton.first().click();
        await page.waitForTimeout(350);
      }
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.waitForTimeout(450);
    },
  },
  {
    name: 'chat-settings-giveaway-channels-modal',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'giveaway',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(650);
      const editButton = page.locator('.managed-giveaway').getByRole('button', {
        name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
      });
      if ((await editButton.count()) > 0) {
        await editButton.first().click();
        await page.waitForTimeout(350);
      }
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.waitForTimeout(250);
      await page
        .getByRole('button', {
          name: /(?:Открыть список|Добавить свой канал|Выбрано)/u,
        })
        .click();
      await page.waitForTimeout(450);
    },
  },
  {
    name: 'chat-settings-giveaway-publish-step',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'giveaway',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(650);
      const editButton = page.locator('.managed-giveaway').getByRole('button', {
        name: /(?:Редактировать|Продолжить сценарий|Продолжить)/u,
      });
      if ((await editButton.count()) > 0) {
        await editButton.first().click();
        await page.waitForTimeout(350);
      }
      await page.getByRole('button', { name: /(?:Далее: условия|К условиям)/u }).click();
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: /(?:Далее: призы|К призам)/u }).click();
      await page.waitForTimeout(450);
    },
  },
  {
    name: 'chat-dialog-comments',
    path: '/chat/preview-chat/dialog/comments',
    searchParams: {
      token: 'preview-comments-token-0001',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-dialog-comments-short-thread',
    path: '/chat/preview-chat/dialog/comments',
    searchParams: {
      token: 'preview-comments-token-0001',
      thread: 'short',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
      await assertCommentsComposerPinned(page);
    },
  },
  {
    name: 'chat-dialog-comments-empty-thread',
    path: '/chat/preview-chat/dialog/comments',
    searchParams: {
      token: 'preview-comments-token-0001',
      thread: 'empty',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-comments',
    path: '/channel/preview-channel/dialog/comments',
    searchParams: {
      token: 'preview-comments-token-0001',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-dialog-suggest',
    path: '/channel/preview-channel/dialog/suggest',
    searchParams: {
      token: 'preview-suggest-token-0001',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-comments',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'comments',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-required-subscription',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'requiredSubscription',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-invitation-access',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'invitationAccess',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-broadcast',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(1000);
    },
  },
  {
    name: 'chat-settings-broadcast-scrolled',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
    },
  },
  {
    name: 'chat-settings-broadcast-time',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
    },
  },
  {
    name: 'chat-settings-broadcast-review',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: /Готово/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings',
    path: '/channel/preview-channel/settings',
  },
  {
    name: 'channel-settings-comments',
    path: '/channel/preview-channel/settings',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /(?:Комментарии|Обсуждение)/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-post-suggestions',
    path: '/channel/preview-channel/settings',
    beforeShot: async (page) => {
      await page.getByRole('button', { name: /Предложка/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-vk-parsing',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'vkParsing',
    },
    beforeShot: async (page) => {
      await page
        .locator('.settings-drilldown__panel--vk-parsing .vk-parsing-card')
        .waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'chat-settings-vk-parsing',
    path: '/chat/preview-chat/settings',
    searchParams: {
      focus: 'vkParsing',
    },
    beforeShot: async (page) => {
      await page
        .locator('.settings-drilldown__panel--vk-parsing .vk-parsing-card')
        .waitFor({ state: 'visible' });
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'channel-settings-broadcast',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(1000);
    },
  },
  {
    name: 'channel-settings-broadcast-scrolled',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
    },
  },
  {
    name: 'channel-settings-broadcast-time',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
    },
  },
  {
    name: 'channel-settings-broadcast-review',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await openBroadcastPlannerTimeSheet(page);
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: /Готово/u }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-settings-broadcast-button-picker',
    path: '/channel/preview-channel/settings',
    searchParams: {
      focus: 'broadcast',
      handoff: '1',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: /кноп/iu }).first().click();
      await page.locator('.broadcast-buttons-sheet__panel').waitFor({ state: 'visible' });
      if ((await page.locator('.broadcast-link-editor').count()) === 0) {
        await page.locator('.broadcast-buttons-sheet__empty-action').first().click();
      }
      const picker = page.locator('.broadcast-link-editor').first();
      await picker.waitFor({ state: 'visible' });
      await page.evaluate(() => {
        document.querySelector('.broadcast-link-editor')?.scrollIntoView({
          block: 'start',
          behavior: 'instant',
        });
        window.scrollBy({ top: -84, behavior: 'instant' });
      });
      const quickAction = page
        .locator('.broadcast-link-editor__preset')
        .filter({ hasText: /Канал/u })
        .first();
      await quickAction.waitFor({ state: 'visible' });
      await quickAction.click();
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats',
    path: '/channel/preview-channel/stats',
  },
  {
    name: 'channel-stats-24h',
    path: '/channel/preview-channel/stats',
    beforeShot: async (page) => {
      await page
        .locator('.channel-insights__chart-controls .channel-insights__range .segmented-control__item')
        .filter({ hasText: /24ч/u })
        .click();
      await page.locator('.channel-stats-graph--continuous').first().waitFor({ state: 'visible' });
      await assertChannelStatsContinuousChart(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-views',
    path: '/channel/preview-channel/stats',
    beforeShot: async (page) => {
      await page
        .locator('.channel-insights__switch .segmented-control__item')
        .filter({ hasText: /Просм\./u })
        .click();
      await waitForVisibleChannelStatsViewsBar(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-views-24h',
    path: '/channel/preview-channel/stats',
    beforeShot: async (page) => {
      await page
        .locator('.channel-insights__switch .segmented-control__item')
        .filter({ hasText: /Просм\./u })
        .click();
      await page
        .locator('.channel-insights__chart-controls .channel-insights__range .segmented-control__item')
        .filter({ hasText: /24ч/u })
        .click();
      await waitForVisibleChannelStatsViewsBar(page);
      await page.locator('.channel-stats-graph--continuous').first().waitFor({ state: 'visible' });
      await assertChannelStatsContinuousChart(page);
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-stats-top-posts',
    path: '/channel/preview-channel/stats',
    beforeShot: async (page) => {
      await page.locator('.channel-top-posts-panel').evaluate((element) => {
        element.scrollIntoView({ block: 'start', behavior: 'instant' });
        window.scrollBy({ top: -116, behavior: 'instant' });
      });
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'channel-events',
    path: '/channel/preview-channel/stats',
    searchParams: {
      section: 'events',
    },
  },
  {
    name: 'system',
    path: '/system',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'legal-agreement',
    path: '/legal/agreement',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'legal-privacy',
    path: '/legal/privacy',
    beforeShot: async (page) => {
      await page.waitForTimeout(350);
    },
  },
  {
    name: 'init-missing',
    path: '/',
    preview: false,
    beforeShot: async (page) => {
      await page.locator('.init-missing-card').waitFor({ state: 'visible' });
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'giveaway-default',
    path: '/giveaways/preview-giveaway',
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-blocked',
    path: '/giveaways/preview-giveaway',
    searchParams: {
      giveaway_state: 'blocked',
    },
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
    path: '/giveaways/preview-giveaway',
    searchParams: {
      giveaway_state: 'blocked',
      giveaway_enter_result: 'joined',
    },
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
    path: '/giveaways/preview-giveaway',
    searchParams: {
      giveaway_state: 'winner',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'giveaway-completed',
    path: '/giveaways/preview-giveaway',
    searchParams: {
      giveaway_state: 'completed',
    },
    beforeShot: async (page) => {
      await page.waitForTimeout(500);
    },
  },
];
const requestedScenarioNames = (process.env.MINIAPP_SCREENSHOT_SCENARIOS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const activeScenarios =
  requestedScenarioNames.length > 0
    ? scenarios.filter((scenario) => requestedScenarioNames.includes(scenario.name))
    : scenarios;

const missingScenarioNames =
  requestedScenarioNames.length > 0
    ? requestedScenarioNames.filter(
        (scenarioName) => !scenarios.some((scenario) => scenario.name === scenarioName),
      )
    : [];

if (missingScenarioNames.length > 0) {
  throw new Error(
    `Unknown screenshot scenarios in MINIAPP_SCREENSHOT_SCENARIOS: ${missingScenarioNames.join(', ')}`,
  );
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

async function openBroadcastPlannerTimeSheet(page) {
  await page.waitForTimeout(1000);

  const dockButton = page.getByRole('button', { name: /^Время$/u }).first();
  const addTimeButton = page.getByRole('button', { name: /^Добавить время$/u }).first();
  const planner = page.locator('.broadcast-planner').first();
  if ((await planner.count()) > 0) {
    await planner.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
  }

  const compactSummary = page.locator('.broadcast-planner__compact-summary').first();
  if ((await compactSummary.count()) > 0) {
    await compactSummary.click();
    await page.waitForTimeout(350);
    return;
  }

  if ((await dockButton.count()) > 0) {
    await dockButton.click();
    await page.waitForTimeout(350);
    return;
  }

  const planIntentButton = page
    .locator('.broadcast-planner__intent-chip')
    .filter({ hasText: /План/u })
    .first();
  if ((await planIntentButton.count()) > 0) {
    await planIntentButton.click();
    await page.waitForTimeout(250);
  }

  const selectedDayButton = page.locator('.broadcast-planner__day.is-selected').first();
  if ((await selectedDayButton.count()) > 0) {
    await selectedDayButton.click();
    await page.waitForTimeout(250);
    if ((await dockButton.count()) > 0) {
      await dockButton.click();
      await page.waitForTimeout(350);
      return;
    }
    if ((await addTimeButton.count()) > 0) {
      await addTimeButton.click();
      await page.waitForTimeout(350);
      return;
    }
  }

  const scheduleCard = page.locator('.broadcast-planner__schedule-card').first();
  if ((await scheduleCard.count()) > 0) {
    await scheduleCard.click();
    await page.waitForTimeout(350);
    return;
  }

  const calendarDay = page.locator('.broadcast-planner__day:not([disabled])').first();
  if ((await calendarDay.count()) > 0) {
    await calendarDay.click();
    await page.waitForTimeout(250);
    if ((await addTimeButton.count()) > 0) {
      await addTimeButton.click();
      await page.waitForTimeout(350);
      return;
    }
    if ((await dockButton.count()) > 0) {
      await dockButton.click();
      await page.waitForTimeout(350);
      return;
    }
  }

  throw new Error('Broadcast planner time sheet trigger was not found.');
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
    await page.waitForSelector('.app-shell', { timeout: 20_000 });
    await page.waitForTimeout(500);
    return;
  }

  await page.waitForSelector('.design-preview__device', { timeout: 20_000 });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  await page.waitForTimeout(500);
}

async function applyNativeScreenshotMode(page, profile) {
  if (screenshotTarget !== 'native') {
    return;
  }

  await applyNativeVisualMode(page, profile);
}

async function simulateKeyboardViewport(page) {
  if (!simulateKeyboard) {
    return;
  }

  await page.addStyleTag({
    content: `
      html[data-max-keyboard-open='true'] .bottom-nav {
        opacity: 0 !important;
        pointer-events: none !important;
        transform: translate(-50%, calc(100% + var(--space-6, 32px) + var(--app-keyboard-overlap, 0px))) !important;
      }
    `,
  });

  await page.evaluate((overlapPx) => {
    const root = document.documentElement;
    root.style.setProperty('--app-keyboard-overlap', `${overlapPx}px`);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('focusin'));
    root.setAttribute('data-max-keyboard-open', 'true');
  }, normalizedKeyboardOverlapPx);
  await page.waitForTimeout(180);
}

async function assertStrictLayout(page, scenario) {
  if (!strictLayout) {
    return;
  }

  await assertAppHasVisibleContent(page, scenario);
  await assertViewportBounds(page, scenario);
  await assertNoUnexpectedHorizontalOverflow(page, scenario);
  await assertPrimaryControlsReachable(page, scenario);
  await assertChartsPainted(page, scenario);
  await assertKeyboardState(page, scenario);
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
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
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
          rect.left < -2 ||
          rect.right > viewportWidth + 2 ||
          (!allowScrolledTop && rect.top < -topTolerance) ||
          rect.top > viewportHeight + 2;
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
  }, simulateKeyboard);

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
    const viewportHeight = window.innerHeight;
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
        return rect.bottom > viewportHeight + 2
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
  }, simulateKeyboard);

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

async function waitForVisibleChannelStatsViewsBar(page) {
  await page.waitForFunction(() => {
    const bars = Array.from(document.querySelectorAll('.channel-stats-graph__bar--views'));
    return bars.some((bar) => {
      if (!(bar instanceof SVGGraphicsElement)) {
        return false;
      }

      const rect = bar.getBoundingClientRect();
      const height = Number.parseFloat(bar.getAttribute('height') ?? '0');
      return rect.width > 0 && rect.height > 0 && height > 0;
    });
  });
}

async function assertKeyboardState(page, scenario) {
  if (!simulateKeyboard || scenario.preview === false || scenario.name.includes('dialog')) {
    return;
  }

  const state = await page.evaluate(() => {
    const root = document.documentElement;
    const nav = document.querySelector('.bottom-nav');
    if (!(nav instanceof HTMLElement)) {
      return null;
    }
    const rect = nav.getBoundingClientRect();
    const style = getComputedStyle(nav);
    return {
      keyboardOpen: root.dataset.maxKeyboardOpen === 'true',
      opacity: Number.parseFloat(style.opacity || '1'),
      pointerEvents: style.pointerEvents,
      top: rect.top,
      viewportHeight: window.innerHeight,
    };
  });

  if (!state) {
    return;
  }

  if (!state.keyboardOpen || state.opacity > 0.05 || state.pointerEvents !== 'none') {
    throw new Error(
      `Scenario ${scenario.name} keyboard simulation did not hide bottom nav ` +
        `(keyboardOpen=${state.keyboardOpen}, opacity=${state.opacity}, pointerEvents=${state.pointerEvents}).`,
    );
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

async function captureDeviceScenarios(browser, profile, baseUrl, outputDir) {
  const device = devices[profile.viewportName];
  if (!device) {
    throw new Error(`Unknown Playwright device profile: ${profile.viewportName}`);
  }

  const context = await browser.newContext({
    ...device,
    colorScheme: colorScheme === 'dark' ? 'dark' : 'light',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });

  if (screenshotTarget === 'native') {
    await installNativeVisualModeInitScript(context);
  }
  if (maxBridgeShimEnabled) {
    await installMaxBridgeShimInitScript(context, profile, {
      startParam: process.env.MINIAPP_SCREENSHOT_START_PARAM?.trim() || '',
      version: process.env.MINIAPP_SCREENSHOT_MAX_VERSION?.trim() || '',
    });
  }

  const page = await context.newPage();
  const shotDir = path.join(outputDir, profile.outputDirName);
  await ensureDir(shotDir);

  for (const scenario of activeScenarios) {
    const url = buildPreviewUrl(
      baseUrl,
      scenario.path,
      profile.queryDevice,
      scenario.searchParams,
      {
        preview: scenario.preview,
      },
    );
    if (scenario.preview === false) {
      await context.clearCookies();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        window.sessionStorage.clear();
        window.localStorage.removeItem('maxim:design-preview-device');
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForApp(page, scenario);
    if (maxBridgeShimEnabled) {
      await assertMaxBridgeShim(page);
    }
    await applyNativeScreenshotMode(page, profile);
    await simulateKeyboardViewport(page);

    if (scenario.beforeShot) {
      await scenario.beforeShot(page);
    }

    if (scenario.name.includes('dialog-comments')) {
      await assertCommentsTopEdgeCovered(page);
      await assertCommentsContentTopInset(page);
    }

    await assertStrictLayout(page, scenario);

    const screenshotPath = path.join(shotDir, `${scenario.name}.png`);
    const locator = resolveScreenshotLocator(page);

    if (locator) {
      await locator.screenshot({
        path: screenshotPath,
        animations: 'disabled',
        timeout: 120_000,
      });
      continue;
    }

    await page.screenshot({
      path: screenshotPath,
      animations: 'disabled',
      timeout: 120_000,
      fullPage: screenshotTarget === 'page',
    });
  }

  await context.close();
}

async function main() {
  const requestedDevice = process.env.MINIAPP_SCREENSHOT_DEVICE?.trim().toLowerCase() ?? 'all';
  const baseUrl = process.env.MINIAPP_SCREENSHOT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const outputDir = path.join(OUTPUT_ROOT, timestamp);
  const deviceKeys =
    requestedDevice === 'all'
      ? Object.keys(deviceProfiles)
      : Object.keys(deviceProfiles).filter((key) => key === requestedDevice);

  if (deviceKeys.length === 0) {
    throw new Error('MINIAPP_SCREENSHOT_DEVICE must be one of: android, iphone, iphone-se, all');
  }

  await ensureDir(outputDir);

  let browser;

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

  try {
    for (const key of deviceKeys) {
      await captureDeviceScenarios(browser, deviceProfiles[key], baseUrl, outputDir);
    }
  } finally {
    await browser.close();
  }

  console.log(`Screenshots saved to ${outputDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
