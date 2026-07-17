import { spawn } from 'node:child_process';

const DEFAULT_BASE_URLS = ['https://major-maksimov.ru/app/'];
const DEFAULT_SCENARIOS = [
  'home',
  'home-channels',
  'home-filter',
  'home-filter-active',
  'home-favorite-picker',
  'home-favorite-categories',
  'publications',
  'publications-legacy',
  'publications-compose',
  'chat-settings',
  'chat-settings-links',
  'chat-settings-apply-target',
  'chat-settings-vk-parsing',
  'channel-settings',
  'channel-settings-post-suggestions-off',
  'channel-settings-polls',
  'channel-settings-vk-parsing',
  'channel-stats',
  'channel-events',
  'events-moderation',
  'events-activity',
  'events-participants',
  'events-participant-sheet',
  'events-participant-controls',
  'events-spam-review',
  'events-spam-diagnostics',
  'channel-dialog-comments',
  'channel-dialog-suggest',
  'legal-agreement',
  'init-missing',
  'giveaway-default',
].join(',');

const QUICK_SCENARIOS = [
  'home',
  'chat-settings',
  'channel-settings',
  'channel-settings-vk-parsing',
  'channel-stats',
  'events-participants',
  'channel-dialog-comments',
  'legal-agreement',
].join(',');

function envFlag(name) {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function splitList(value, fallback) {
  const items = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function hostLabel(baseUrl) {
  const url = new URL(baseUrl);
  return url.hostname.replace(/[^a-z0-9.-]+/giu, '-');
}

function runCapture(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['scripts/capture-miniapp-preview.mjs'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        ...env,
      },
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Visual capture failed with ${signal ?? `exit code ${code}`}.`));
    });
  });
}

async function main() {
  const quick = envFlag('MINIAPP_VISUAL_AUDIT_QUICK');
  const baseUrls = splitList(process.env.MINIAPP_VISUAL_AUDIT_BASE_URLS, DEFAULT_BASE_URLS);
  const devices = splitList(process.env.MINIAPP_VISUAL_AUDIT_DEVICES, ['all']);
  const scenarios =
    process.env.MINIAPP_VISUAL_AUDIT_SCENARIOS?.trim() ||
    (quick ? QUICK_SCENARIOS : DEFAULT_SCENARIOS);
  const schemes = splitList(
    process.env.MINIAPP_VISUAL_AUDIT_COLOR_SCHEMES,
    quick ? ['light'] : ['light', 'dark'],
  );
  const keyboardDevices = splitList(
    process.env.MINIAPP_VISUAL_AUDIT_KEYBOARD_DEVICES,
    quick ? [] : ['android', 'iphone'],
  );
  const keyboardScenario =
    process.env.MINIAPP_VISUAL_AUDIT_KEYBOARD_SCENARIOS?.trim() || 'home,chat-settings';

  for (const baseUrl of baseUrls) {
    for (const device of devices) {
      for (const scheme of schemes) {
        console.log(`\n== Visual audit: ${baseUrl} device=${device} scheme=${scheme} native ==`);
        await runCapture({
          MINIAPP_SCREENSHOT_BASE_URL: baseUrl,
          MINIAPP_SCREENSHOT_DEVICE: device,
          MINIAPP_SCREENSHOT_SCENARIOS: scenarios,
          MINIAPP_SCREENSHOT_TARGET: 'native',
          MINIAPP_SCREENSHOT_COLOR_SCHEME: scheme,
          MINIAPP_SCREENSHOT_STRICT_LAYOUT: '1',
          MINIAPP_SCREENSHOT_STRICT_CONTRAST: '1',
          MINIAPP_SCREENSHOT_STRICT_ACCESSIBILITY: '1',
          MINIAPP_SCREENSHOT_LABEL: `${hostLabel(baseUrl)}-${device}-${scheme}-native`,
        });
      }
    }

    for (const device of keyboardDevices) {
      console.log(`\n== Visual audit: ${baseUrl} device=${device} simulated-keyboard ==`);
      await runCapture({
        MINIAPP_SCREENSHOT_BASE_URL: baseUrl,
        MINIAPP_SCREENSHOT_DEVICE: device,
        MINIAPP_SCREENSHOT_SCENARIOS: keyboardScenario,
        MINIAPP_SCREENSHOT_TARGET: 'native',
        MINIAPP_SCREENSHOT_COLOR_SCHEME: 'light',
        MINIAPP_SCREENSHOT_STRICT_LAYOUT: '1',
        MINIAPP_SCREENSHOT_STRICT_CONTRAST: '1',
        MINIAPP_SCREENSHOT_STRICT_ACCESSIBILITY: '1',
        MINIAPP_SCREENSHOT_SIMULATE_KEYBOARD: '1',
        MINIAPP_SCREENSHOT_LABEL: `${hostLabel(baseUrl)}-${device}-keyboard`,
      });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
