import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, devices } from 'playwright';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { stopChildProcess } from '../../../scripts/miniapp-local-server.mjs';

// Exercise the real built entry point, session transport and router, not a page fixture.
const base = 'http://127.0.0.1:4178/app/';
const baseline = process.env.COMMENT_STARTUP_BASELINE === '1';
const output = await mkdtemp(path.join(tmpdir(), 'maxim-comment-startup-'));
const workspace = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  await readFile(path.join(workspace, 'dist/.vite/manifest.json'), 'utf8'),
);
const pageFile = manifest['src/pages/channel-dialog-page.tsx'].file;
const server = spawn(
  process.execPath,
  [
    path.resolve(workspace, '../../node_modules/vite/bin/vite.js'),
    'preview',
    '--host',
    '127.0.0.1',
    '--port',
    '4178',
    '--strictPort',
  ],
  { cwd: workspace, stdio: 'pipe' },
);
const browser = await chromium.launch();
const profiles = [
  {
    name: 'android',
    device: devices['Pixel 7'],
    platform: 'android',
    colorScheme: 'light',
    profile: 'moderation',
  },
  {
    name: 'iphone',
    device: devices['iPhone 15'],
    platform: 'ios',
    colorScheme: 'dark',
    profile: 'publisher',
  },
  {
    name: 'desktop',
    device: { viewport: { width: 1280, height: 900 } },
    platform: 'web',
    colorScheme: 'light',
    profile: 'moderation',
  },
  {
    name: 'profile-denied',
    device: devices['Pixel 7'],
    platform: 'android',
    colorScheme: 'light',
    profile: 'moderation',
    denyProfile: true,
  },
];

try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (server.exitCode !== null) throw new Error('Preview server exited; port 4178 must be free');
    if (
      await fetch(base)
        .then((response) => response.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await delay(100);
  }
  assert.ok(ready, 'preview starts');
  for (const profile of profiles) {
    const context = await browser.newContext({
      ...profile.device,
      colorScheme: profile.colorScheme,
      reducedMotion: 'reduce',
    });
    const timeline = [];
    const errors = [];
    const unexpected = [];
    const token = 'startup-test-thread-token';
    await installMaxBridgeShimInitScript(context, profile, { colorScheme: profile.colorScheme });
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/')) {
        const endpoint = url.pathname.slice('/api/v1'.length);
        timeline.push({ endpoint, phase: 'start', at: performance.now() });
        await delay(450);
        let body;
        if (endpoint === '/auth/miniapp-session') {
          body = { authenticated: true, csrfToken: 'c'.repeat(43), expiresInSec: 3600 };
        } else if (endpoint === '/me') {
          if (profile.denyProfile) {
            await delay(900);
            assert.equal(
              await page.locator('.channel-dialog-message').count(),
              0,
              'prefetched private data must not render before profile authorization',
            );
          }
          body = { userId: '900719925', profile: profile.profile, homeRoute: '/' };
        } else if (endpoint === '/channels/-123/dialog/comments') {
          assert.equal(url.searchParams.get('token'), token);
          body = {
            chatId: '-123',
            type: 'comments',
            messages: [
              {
                id: 'startup-comment',
                type: 'comments',
                text: 'Startup comment',
                authorUserId: '900719925',
                authorDisplayName: 'Test',
                createdAt: '2026-09-16T00:00:00.000Z',
              },
            ],
          };
        } else if (endpoint.endsWith('/moderation')) {
          body = {
            canManage: false,
            restriction: {
              userId: '900719925',
              displayName: null,
              kind: null,
              expiresAt: null,
              reason: '',
              revision: 0,
            },
          };
        } else if (endpoint.includes('boot-trace')) {
          body = { ok: true };
        } else {
          unexpected.push(endpoint);
          body = {};
        }
        timeline.push({ endpoint, phase: 'end', at: performance.now() });
        await route.fulfill({
          json: body,
          status: endpoint === '/me' && profile.denyProfile ? 403 : 200,
        });
      } else if (url.origin === new URL(base).origin) {
        await route.continue();
      } else {
        // Never send fixture credentials, telemetry or requests to real services.
        await route.fulfill({ contentType: 'application/javascript', body: '' });
      }
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith(pageFile)) {
        timeline.push({ endpoint: 'page-chunk', phase: 'start', at: performance.now() });
      }
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 120,
      downloadThroughput: 187_500,
      uploadThroughput: 93_750,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const start = performance.now();
    await page.goto(`${base}channel/-123/dialog/comments?token=${token}`, {
      waitUntil: 'domcontentloaded',
    });
    if (profile.denyProfile) {
      await page.getByText('Не удалось открыть приложение', { exact: true }).waitFor();
      assert.equal(await page.locator('.channel-dialog-message').count(), 0);
      if (!baseline) {
        assert.ok(
          timeline.some(
            (item) => item.endpoint === '/channels/-123/dialog/comments' && item.phase === 'end',
          ),
        );
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(unexpected, []);
      console.log('PASS denied profile never renders prefetched comments');
      await context.close();
      continue;
    }
    await page.getByText('Startup comment', { exact: true }).waitFor({ timeout: 30_000 });
    const readyMs = Math.round(performance.now() - start);
    const event = (endpoint, phase) =>
      timeline.find((item) => item.endpoint === endpoint && item.phase === phase)?.at;
    const meEnd = event('/me', 'end');
    const commentsStart = event('/channels/-123/dialog/comments', 'start');
    const chunkStart = event('page-chunk', 'start');
    assert.ok(meEnd && commentsStart && chunkStart, 'all startup milestones observed');
    if (!baseline) {
      assert.ok(commentsStart < meEnd, 'comment request must overlap profile discovery');
      assert.ok(chunkStart < meEnd, 'comment code must overlap profile discovery');
    }
    assert.equal(
      timeline.filter(
        (item) => item.endpoint === '/channels/-123/dialog/comments' && item.phase === 'start',
      ).length,
      1,
      'no duplicate first-page request',
    );
    const resources = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((entry) => ({ name: new URL(entry.name).pathname, bytes: entry.decodedBodySize })),
    );
    if (!baseline)
      assert.ok(
        !resources.some((entry) =>
          /max-rich-text-editor-|max-markdown-editor-|comment-theme-sheet-/u.test(entry.name),
        ),
        'unused tools stay lazy',
      );
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('.channel-dialog-compose').getBoundingClientRect();
      const comment = document.querySelector('.channel-dialog-message').getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - innerWidth,
        gap: composer.top - comment.bottom,
      };
    });
    assert.ok(layout.overflow <= 1 && layout.gap >= 0, 'comments and composer fit');
    await page.screenshot({ path: path.join(output, `${profile.name}.png`) });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    console.log(
      JSON.stringify({
        profile: profile.name,
        baseline,
        readyMs,
        commentRequestAfterProfileMs: Math.round(commentsStart - meEnd),
        chunkAfterProfileMs: Math.round(chunkStart - meEnd),
        jsDecodedBytes: resources
          .filter((item) => item.name.endsWith('.js'))
          .reduce((sum, item) => sum + item.bytes, 0),
      }),
    );
    await context.close();
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
  console.log(`Screenshots: ${output}`);
}
