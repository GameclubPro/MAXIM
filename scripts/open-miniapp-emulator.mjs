import process from 'node:process';
import { chromium, webkit } from 'playwright';
import {
  captureBrowserLaunchOptions,
  readPhoneMetrics,
  resolveCaptureDevice,
} from './miniapp-smartphone.mjs';
import previewDevicePresets from '../apps/miniapp/src/lib/preview-device-presets.json' with { type: 'json' };
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  isLocalMiniappBaseUrl,
  stopChildProcess,
} from './miniapp-local-server.mjs';
import { assertMaxBridgeShim, installMaxBridgeShimInitScript } from './miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from './miniapp-native-visual-mode.mjs';
import { LOCAL_MINIAPP_BASE_URL } from './miniapp-visual-config.mjs';

const deviceProfiles = previewDevicePresets;

function printUsage() {
  console.log(`Usage:
  npm run emulator:miniapp -- [--device iphone|android|iphone-se] [--route '/'] [--theme light|dark] [--target smartphone|device|native] [--max-bridge|--no-max-bridge]
  npm run emulator:miniapp -- [--base-url http://127.0.0.1:3000/app/] [--reuse-server]

Environment:
  MINIAPP_EMULATOR_DEVICE
  MINIAPP_EMULATOR_ROUTE
  MINIAPP_EMULATOR_BASE_URL
  MINIAPP_EMULATOR_COLOR_SCHEME=light|dark
  MINIAPP_EMULATOR_TARGET=smartphone|device|native (default: smartphone)
  MINIAPP_EMULATOR_BROWSER=auto|webkit|chromium
  MINIAPP_PHONE_METRICS_PATH=/absolute/path/to/phone-metrics.json
  MINIAPP_EMULATOR_MAX_BRIDGE=1
  MINIAPP_EMULATOR_REUSE_SERVER=1
  MINIAPP_EMULATOR_HEADLESS=1
  MINIAPP_EMULATOR_TIMEOUT_MS=1500
`);
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--reuse-server') {
      options.reuseServer = true;
      continue;
    }

    if (arg === '--headless') {
      options.headless = true;
      continue;
    }

    if (arg === '--max-bridge') {
      options.maxBridge = true;
      continue;
    }

    if (arg === '--no-max-bridge') {
      options.maxBridge = false;
      continue;
    }

    const nextValue = argv[index + 1];
    if (nextValue == null) {
      throw new Error(`Missing value for ${arg}`);
    }

    if (arg === '--device') {
      options.device = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--route') {
      options.route = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--base-url') {
      options.baseUrl = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--target') {
      options.target = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--theme') {
      options.colorScheme = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--timeout-ms') {
      options.timeoutMs = Number(nextValue);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function envFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function optionalEnvFlag(name) {
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

function envNumber(name) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return null;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

function envString(name) {
  const value = process.env[name]?.trim();
  return value || '';
}

function buildPreviewUrl(baseUrl, routePath, queryDevice) {
  const base = new URL(baseUrl);
  const routeUrl = new URL(routePath, 'http://preview.local');
  const normalizedBasePath = base.pathname.endsWith('/')
    ? base.pathname.slice(0, -1)
    : base.pathname;
  const normalizedRoutePath = routeUrl.pathname.startsWith('/')
    ? routeUrl.pathname
    : `/${routeUrl.pathname}`;
  const url = new URL(base.toString());

  url.pathname = `${normalizedBasePath}${normalizedRoutePath}`;
  url.search = routeUrl.search;
  url.searchParams.set('preview', '1');
  url.searchParams.set('device', queryDevice);

  return url.toString();
}

async function waitForPreviewApp(page) {
  await page.waitForSelector('.design-preview__device', { timeout: 20_000 });
  await page.waitForSelector('.app-shell', { timeout: 20_000 });
  await page.waitForLoadState('networkidle');
}

function formatLaunchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Executable doesn't exist") ||
    message.includes('Please run the following command')
  ) {
    return new Error(
      [
        'Playwright Chromium is not installed.',
        'Run `npx playwright install chromium` and retry.',
      ].join(' '),
    );
  }

  if (message.includes('error while loading shared libraries')) {
    return new Error(
      [
        'Playwright Chromium cannot start because system libraries are missing.',
        'Use `MINIAPP_EMULATOR_HEADLESS=1` for a smoke check or install Playwright browser deps for your OS.',
      ].join(' '),
    );
  }

  return error instanceof Error ? error : new Error(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const deviceKey = (args.device ?? process.env.MINIAPP_EMULATOR_DEVICE ?? 'iphone')
    .trim()
    .toLowerCase();
  const route = (args.route ?? process.env.MINIAPP_EMULATOR_ROUTE ?? '/').trim() || '/';
  let baseUrl = (
    args.baseUrl ??
    process.env.MINIAPP_EMULATOR_BASE_URL ??
    LOCAL_MINIAPP_BASE_URL
  ).trim();
  const target = (args.target ?? process.env.MINIAPP_EMULATOR_TARGET ?? 'smartphone')
    .trim()
    .toLowerCase();
  const colorScheme = (args.colorScheme ?? process.env.MINIAPP_EMULATOR_COLOR_SCHEME ?? 'light')
    .trim()
    .toLowerCase();
  const envMaxBridge = optionalEnvFlag('MINIAPP_EMULATOR_MAX_BRIDGE');
  const nativeTarget = target === 'native' || target === 'smartphone';
  const maxBridgeEnabled = args.maxBridge ?? envMaxBridge ?? nativeTarget;
  const reuseServer = args.reuseServer ?? envFlag('MINIAPP_EMULATOR_REUSE_SERVER');
  if (!reuseServer && !args.baseUrl && !process.env.MINIAPP_EMULATOR_BASE_URL?.trim()) {
    baseUrl = await allocateMiniappBaseUrl(baseUrl);
  }
  const headless = args.headless ?? envFlag('MINIAPP_EMULATOR_HEADLESS');
  const timeoutMs =
    args.timeoutMs ?? envNumber('MINIAPP_EMULATOR_TIMEOUT_MS') ?? (headless ? 1_500 : 0);
  let profile = deviceProfiles[deviceKey];

  if (!profile) {
    throw new Error('Device must be one of: android, iphone, iphone-se');
  }

  if (!['smartphone', 'device', 'native'].includes(target)) {
    throw new Error('Target must be one of: smartphone, device, native');
  }

  if (colorScheme !== 'light' && colorScheme !== 'dark') {
    throw new Error('Theme must be one of: light, dark');
  }

  const capture = resolveCaptureDevice(profile, {
    target,
    engine: process.env.MINIAPP_EMULATOR_BROWSER,
    metrics: await readPhoneMetrics(process.env.MINIAPP_PHONE_METRICS_PATH),
  });
  profile = capture.profile;

  const previewUrl = buildPreviewUrl(baseUrl, route, profile.queryDevice);
  const shouldManageDevServer = !reuseServer && isLocalMiniappBaseUrl(baseUrl);

  let devServerProcess = null;
  let browser = null;

  const cleanup = async () => {
    if (browser) {
      await browser.close();
      browser = null;
    }
    await stopChildProcess(devServerProcess);
    devServerProcess = null;
  };

  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    if (shouldManageDevServer) {
      devServerProcess = await ensureMiniappDevServer(baseUrl, { log: console.log });
    }

    try {
      browser = await { chromium, webkit }[capture.browserName].launch(
        captureBrowserLaunchOptions(capture.browserName, baseUrl, headless),
      );
    } catch (error) {
      throw new Error(
        `Cannot launch ${capture.browserName}. Run npx playwright install --with-deps ${capture.browserName}. ${formatLaunchError(error).message}`,
      );
    }

    const context = await browser.newContext({
      ...capture.contextOptions,
      colorScheme,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    });
    if (nativeTarget) {
      await installNativeVisualModeInitScript(context);
    }
    if (maxBridgeEnabled) {
      await installMaxBridgeShimInitScript(context, profile, {
        startParam: envString('MINIAPP_EMULATOR_START_PARAM'),
        userId: envNumber('MINIAPP_EMULATOR_USER_ID'),
        version: envString('MINIAPP_EMULATOR_MAX_VERSION'),
        colorScheme,
      });
    }

    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
    await waitForPreviewApp(page);
    if (maxBridgeEnabled) {
      await assertMaxBridgeShim(page);
    }
    if (nativeTarget) {
      await applyNativeVisualMode(page, profile);
    }

    console.log(`Mini app emulator ready (${target}): ${previewUrl}`);
    if (capture.phone)
      console.log(
        `WebView ${capture.phone.viewport.width}x${capture.phone.viewport.height}, ${capture.browserName}. Host panels are excluded from this interactive window; phone screenshots include an approximate host frame.`,
      );

    if (timeoutMs > 0) {
      await page.waitForTimeout(timeoutMs);
      await context.close();
      return;
    }

    console.log('Close the Playwright browser window to stop the emulator.');
    await new Promise((resolve) => {
      browser.once('disconnected', resolve);
    });
    await context.close();
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
