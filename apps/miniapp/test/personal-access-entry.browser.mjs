import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(base);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-personal-access-'));
let browser;
try {
  browser = await chromium.launch();
  for (const [deviceName, device] of [
    ['iphone', devices['iPhone 15']],
    ['android', devices['Pixel 7']],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      for (const profile of ['moderation', 'publisher']) {
        const context = await browser.newContext({ ...device, colorScheme });
        try {
          // FLAG: Exercise real components through the local preview transport only.
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          await context.route('**/src/lib/api/preview-transport-runtime.ts', async (route) => {
            const response = await route.fetch();
            const source = await response.text();
            const marker = 'const result = await handler(context);';
            assert.ok(source.includes(marker));
            await route.fulfill({
              response,
              body: source.replace(
                marker,
                `${marker}
              if (window.__personalEntryPending && result !== PREVIEW_NOT_HANDLED &&
                ['/chats', '/channels', '/publisher/entities'].includes(context.url.pathname)) {
                window.__personalEntryPolls = (window.__personalEntryPolls ?? 0) + 1;
                if (Array.isArray(result)) return [];
                if (context.url.pathname === '/publisher/entities') return {
                  items: [], nextCursor: null, filteredTotal: 0,
                  summary: { total: 0, chat: 0, channel: 0, ready: 0, attention: 0 }, accessVerificationPending: true };
                return { ...result, items: [],
                  refresh: { ...result.refresh, complete: false, userVisibleComplete: false,
                    backoffActive: false, cursor: 0, nextPollAfterMs: 1500 },
                  snapshot: null, diff: undefined };
              }
            `,
              ),
            });
          });
          await installMaxBridgeShimInitScript(context, {}, { colorScheme });
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          const cards = page.locator(
            profile === 'publisher' ? '.publisher-entity-row' : '.chat-card[data-entity-id]',
          );
          await page.goto(`${base}?preview=1&profile=${profile}&view=chat`);
          await cards.first().waitFor();
          // A second launch keeps browser storage but must not show its old cards.
          await context.addInitScript(() => {
            window.__personalEntryPending = true;
          });
          await page.reload();
          await page.waitForFunction(() => window.__personalEntryPolls >= 2);
          await applyNativeVisualMode(page, {
            safeTop: deviceName === 'iphone' ? 59 : 24,
            safeBottom: deviceName === 'iphone' ? 34 : 24,
          });
          assert.equal(
            await cards.count(),
            0,
            'Previous-launch cards appeared before human verification',
          );
          if (profile === 'publisher')
            await page.getByText('Проверяю ваши права', { exact: true }).waitFor();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
            false,
          );
          await page.screenshot({
            path: path.join(output, `${profile}-${deviceName}-${colorScheme}.png`),
          });
          await page.evaluate(() => {
            window.__personalEntryPending = false;
          });
          await cards.first().waitFor();
          assert.deepEqual(errors, []);
          console.log(
            `PASS ${profile} ${deviceName} ${colorScheme}: no previous-launch cards, pending polling, verified cards`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log(`Screenshots: ${output}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
