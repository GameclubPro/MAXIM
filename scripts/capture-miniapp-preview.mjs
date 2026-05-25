import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import previewDevicePresets from '../apps/miniapp/src/lib/preview-device-presets.json' with { type: 'json' };

const DEFAULT_BASE_URL = 'https://maxim.play-team.ru/app/';
const OUTPUT_ROOT = path.resolve(process.cwd(), 'artifacts/miniapp-screenshots');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

const deviceProfiles = previewDevicePresets;

const screenshotTarget = (process.env.MINIAPP_SCREENSHOT_TARGET ?? 'device').trim().toLowerCase();

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
    name: 'channel-stats-views',
    path: '/channel/preview-channel/stats',
    beforeShot: async (page) => {
      await page
        .locator('.channel-insights__switch .segmented-control__item')
        .filter({ hasText: /Просм\./u })
        .click();
      await page.locator('.channel-stats-graph__bar--views').first().waitFor({ state: 'visible' });
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

if (requestedScenarioNames.length > 0 && activeScenarios.length === 0) {
  throw new Error(
    `No screenshot scenarios matched MINIAPP_SCREENSHOT_SCENARIOS=${requestedScenarioNames.join(',')}`,
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

async function openBroadcastPlannerTimeSheet(page) {
  await page.waitForTimeout(1000);

  const dockButton = page.getByRole('button', { name: /^Время$/u }).first();
  const addTimeButton = page.getByRole('button', { name: /^Добавить время$/u }).first();
  const planner = page.locator('.broadcast-planner').first();
  if ((await planner.count()) > 0) {
    await planner.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
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

function buildPreviewUrl(baseUrl, routePath, queryDevice, scenarioSearchParams = {}) {
  const base = new URL(baseUrl);
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const normalizedRoutePath = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const url = new URL(base.toString());

  url.pathname = `${normalizedBasePath}${normalizedRoutePath}`;
  url.searchParams.set('preview', '1');
  url.searchParams.set('device', queryDevice);
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

async function waitForPreviewApp(page) {
  await page.waitForSelector('.design-preview__device', { timeout: 20_000 });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

async function applyNativeScreenshotMode(page, profile) {
  if (screenshotTarget !== 'native') {
    return;
  }

  await page.addStyleTag({
    content: `
      .design-preview {
        display: block !important;
        min-height: 100dvh !important;
        padding: 0 !important;
        background: transparent !important;
      }

      .design-preview__dock {
        display: none !important;
      }

      .design-preview__stage,
      .design-preview__device,
      .design-preview__device-screen {
        display: block !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        min-height: 100dvh !important;
        height: auto !important;
        padding: 0 !important;
        margin: 0 !important;
        overflow: visible !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }

      .design-preview .app-shell {
        min-height: var(--app-viewport-height) !important;
        height: auto !important;
        width: min(100%, var(--app-shell-max-width)) !important;
        max-width: var(--app-shell-max-width) !important;
        padding: calc(var(--app-safe-top) + 10px) var(--app-page-gutter) 0 !important;
        padding-bottom: calc(
          var(--app-bottom-nav-height) + var(--app-safe-bottom) + 8px + 12px
        ) !important;
        overflow: visible !important;
      }

      .design-preview .app-shell--immersive {
        width: 100% !important;
        max-width: none !important;
        height: var(--app-viewport-height) !important;
        min-height: var(--app-viewport-height) !important;
        padding: 0 !important;
        overflow: hidden !important;
      }

      .design-preview .bottom-nav {
        width: min(calc(100% - 24px), var(--app-shell-max-width)) !important;
      }

      .design-preview .compact-page-header {
        max-width: none !important;
      }
    `,
  });

  await page.evaluate(({ safeTop, safeBottom }) => {
    const root = document.documentElement;
    root.style.setProperty('--safe-top', `${safeTop}px`);
    root.style.setProperty('--safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-safe-top', `${safeTop}px`);
    root.style.setProperty('--app-safe-bottom', `${safeBottom}px`);
    root.style.setProperty('--app-viewport-height', `${window.innerHeight}px`);
    window.dispatchEvent(new Event('resize'));
  }, profile);
  await page.waitForTimeout(120);
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
    colorScheme: 'light',
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
  });

  const page = await context.newPage();
  const shotDir = path.join(outputDir, profile.outputDirName);
  await ensureDir(shotDir);

  for (const scenario of activeScenarios) {
    const url = buildPreviewUrl(baseUrl, scenario.path, profile.queryDevice, scenario.searchParams);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForPreviewApp(page);
    await applyNativeScreenshotMode(page, profile);

    if (scenario.beforeShot) {
      await scenario.beforeShot(page);
    }

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
