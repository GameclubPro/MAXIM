import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium, devices } from 'playwright';

const DEFAULT_BASE_URL = 'https://maxim.play-team.ru/app/';
const OUTPUT_ROOT = path.resolve(process.cwd(), 'artifacts/miniapp-screenshots');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

const deviceProfiles = {
  android: {
    queryDevice: 'android',
    viewportName: 'Pixel 7',
    outputDirName: 'android',
  },
  iphone: {
    queryDevice: 'iphone',
    viewportName: 'iPhone 15',
    outputDirName: 'iphone',
  },
  'iphone-se': {
    queryDevice: 'iphone',
    viewportName: 'iPhone SE',
    outputDirName: 'iphone-se',
  },
};

const screenshotTarget = (process.env.MINIAPP_SCREENSHOT_TARGET ?? 'device').trim().toLowerCase();

const scenarios = [
  {
    name: 'home',
    path: '/',
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
      await page.getByRole('button', { name: /Далее: условия/u }).click();
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: /Далее: призы/u }).click();
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: '2 раза' }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: '2 раза' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: 'Сохранить время' }).click();
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
      await page.getByRole('button', { name: /Комментарии/u }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: '2 раза' }).click();
      await page.waitForTimeout(300);
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
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Выбрать количество' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: '2 раза' }).click();
      await page.waitForTimeout(150);
      await page.getByRole('button', { name: 'Сохранить время' }).click();
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'channel-stats',
    path: '/channel/preview-channel/stats',
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

function resolveScreenshotLocator(page) {
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
      fullPage: true,
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
