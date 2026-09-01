import { spawn } from 'node:child_process';
import {
  ensureMiniappDevServer,
  isLocalMiniappBaseUrl,
  stopChildProcess,
} from './miniapp-local-server.mjs';
import { resolveMiniappVisualAuditBaseUrls } from './miniapp-visual-config.mjs';

const DEFAULT_SCENARIOS = [
  'home',
  'home-channels',
  'home-filter',
  'home-filter-active',
  'home-favorite-picker',
  'home-favorite-categories',
  'publications',
  'publications-publisher',
  'publications-publisher-create',
  'publications-publisher-schedules',
  'publications-publisher-history',
  'publications-publisher-empty',
  'publications-publisher-large',
  'publications-publisher-error',
  'publications-publisher-compose',
  'publications-publisher-compose-large',
  'publications-publisher-compose-selected',
  'publications-publisher-compose-media-first',
  'publications-publisher-compose-unready-target',
  'publications-publisher-compose-missing-target',
  'publications-legacy',
  'publications-compose',
  'publik',
  'publisher-entities-channel-only',
  'publisher-entities-empty',
  'publisher-entity-modules',
  'publisher-entity-modules-blocked',
  'publisher-channel-modules',
  'publisher-channel-suggestions-open-draft',
  'publisher-channel-suggestions-cancel-confirm',
  'publisher-channel-suggestions-history',
  'publisher-entity-modules-vk',
  'publisher-channel-modules-vk-editor',
  'chat-settings',
  'chat-settings-publisher-policy-setup',
  'chat-settings-publisher-policy-error',
  'chat-settings-links',
  'chat-settings-apply-target',
  'channel-settings',
  'channel-settings-post-signature',
  'channel-settings-post-suggestions-off',
  'channel-settings-polls',
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
  'channel-dialog-comments-publisher',
  'channel-dialog-suggest',
  'channel-dialog-suggest-publisher',
  'legal-agreement',
  'init-missing',
  'giveaway-default',
].join(',');

const QUICK_SCENARIOS = [
  'home',
  'publisher-entity-modules-vk',
  'chat-settings',
  'channel-settings',
  'channel-settings-post-signature',
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

let activeCaptureProcess = null;

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
    activeCaptureProcess = child;

    const clearActiveCapture = () => {
      if (activeCaptureProcess === child) {
        activeCaptureProcess = null;
      }
    };

    child.once('error', (error) => {
      clearActiveCapture();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearActiveCapture();
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
  const baseUrls = resolveMiniappVisualAuditBaseUrls();
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
    quick ? [] : ['android', 'iphone', 'iphone-se'],
  );
  const keyboardScenario =
    process.env.MINIAPP_VISUAL_AUDIT_KEYBOARD_SCENARIOS?.trim() ||
    'home,chat-settings,publications-publisher-compose';
  let activeDevServerProcess = null;

  const cleanup = async () => {
    await stopChildProcess(activeCaptureProcess);
    activeCaptureProcess = null;
    await stopChildProcess(activeDevServerProcess);
    activeDevServerProcess = null;
  };
  const handleSignal = (signal) => {
    void cleanup().finally(() => {
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    for (const baseUrl of baseUrls) {
      const localBaseUrl = isLocalMiniappBaseUrl(baseUrl);
      activeDevServerProcess = localBaseUrl
        ? await ensureMiniappDevServer(baseUrl, { log: console.log })
        : null;

      try {
        for (const device of devices) {
          for (const scheme of schemes) {
            console.log(
              `\n== Visual audit: ${baseUrl} device=${device} scheme=${scheme} native ==`,
            );
            await runCapture({
              MINIAPP_SCREENSHOT_BASE_URL: baseUrl,
              MINIAPP_SCREENSHOT_DEVICE: device,
              MINIAPP_SCREENSHOT_SCENARIOS: scenarios,
              MINIAPP_SCREENSHOT_TARGET: 'native',
              MINIAPP_SCREENSHOT_COLOR_SCHEME: scheme,
              MINIAPP_SCREENSHOT_STRICT_LAYOUT: '1',
              MINIAPP_SCREENSHOT_STRICT_CONTRAST: '1',
              MINIAPP_SCREENSHOT_STRICT_ACCESSIBILITY: '1',
              MINIAPP_SCREENSHOT_REUSE_SERVER: localBaseUrl ? '1' : '0',
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
            MINIAPP_SCREENSHOT_REUSE_SERVER: localBaseUrl ? '1' : '0',
            MINIAPP_SCREENSHOT_LABEL: `${hostLabel(baseUrl)}-${device}-keyboard`,
          });
        }
      } finally {
        await stopChildProcess(activeDevServerProcess);
        activeDevServerProcess = null;
      }
    }
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
