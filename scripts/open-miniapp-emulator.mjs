import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000/app/';
const DEFAULT_WAIT_MS = 30_000;

const deviceProfiles = {
  android: {
    queryDevice: 'android',
    viewportName: 'Pixel 7',
  },
  iphone: {
    queryDevice: 'iphone',
    viewportName: 'iPhone 15',
  },
  'iphone-se': {
    queryDevice: 'iphone',
    viewportName: 'iPhone SE',
  },
};

function printUsage() {
  console.log(`Usage:
  npm run emulator:miniapp -- [--device iphone|android|iphone-se] [--route '/']
  npm run emulator:miniapp -- [--base-url http://127.0.0.1:3000/app/] [--reuse-server]

Environment:
  MINIAPP_EMULATOR_DEVICE
  MINIAPP_EMULATOR_ROUTE
  MINIAPP_EMULATOR_BASE_URL
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

function envNumber(name) {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return null;
  }

  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
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

function isLocalBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        redirect: 'manual',
      });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
    } catch {
      // Keep polling until the dev server is ready.
    }

    await sleep(500);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function startMiniAppDevServer(baseUrl) {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const port = url.port || '3000';

  return spawn(
    'npm',
    ['run', 'dev', '--workspace', '@maxim/miniapp', '--', '--host', host, '--port', port],
    {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
      },
    },
  );
}

async function stopChildProcess(childProcess) {
  if (
    !childProcess ||
    childProcess.killed ||
    childProcess.exitCode !== null ||
    childProcess.signalCode !== null
  ) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      childProcess.kill('SIGKILL');
    }, 5_000);

    childProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    childProcess.kill('SIGTERM');
  });
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
  const baseUrl = (
    args.baseUrl ??
    process.env.MINIAPP_EMULATOR_BASE_URL ??
    DEFAULT_BASE_URL
  ).trim();
  const reuseServer = args.reuseServer ?? envFlag('MINIAPP_EMULATOR_REUSE_SERVER');
  const headless = args.headless ?? envFlag('MINIAPP_EMULATOR_HEADLESS');
  const timeoutMs =
    args.timeoutMs ?? envNumber('MINIAPP_EMULATOR_TIMEOUT_MS') ?? (headless ? 1_500 : 0);
  const profile = deviceProfiles[deviceKey];

  if (!profile) {
    throw new Error('Device must be one of: android, iphone, iphone-se');
  }

  const device = devices[profile.viewportName];
  if (!device) {
    throw new Error(`Unknown Playwright device profile: ${profile.viewportName}`);
  }

  const previewUrl = buildPreviewUrl(baseUrl, route, profile.queryDevice);
  const shouldManageDevServer = !reuseServer && isLocalBaseUrl(baseUrl);

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
      try {
        await waitForUrl(baseUrl, 1_500);
        console.log(`Reusing existing mini-app dev server at ${baseUrl}`);
      } catch {
        devServerProcess = startMiniAppDevServer(baseUrl);
        await waitForUrl(baseUrl, DEFAULT_WAIT_MS);
      }
    }

    try {
      browser = await chromium.launch({
        headless,
      });
    } catch (error) {
      throw formatLaunchError(error);
    }

    const context = await browser.newContext({
      ...device,
      colorScheme: 'light',
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    });
    const page = await context.newPage();
    await page.goto(previewUrl, { waitUntil: 'domcontentloaded' });
    await waitForPreviewApp(page);

    console.log(`Mini app emulator ready: ${previewUrl}`);

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
