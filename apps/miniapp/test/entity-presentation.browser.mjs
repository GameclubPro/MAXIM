import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { installNativeVisualModeInitScript } from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3015/app/');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
try {
  for (const [width, height, platform, theme] of [
    [390, 844, 'ios', 'light'],
    [360, 800, 'android', 'dark'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let imageAttempts = 0;
    await page.route('**/presentation-test-photo.svg', (route) => {
      imageAttempts += 1;
      return imageAttempts === 1
        ? route.abort('failed')
        : route.fulfill({
            contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#2467ee"/></svg>',
          });
    });
    await page.goto(new URL('?preview=1&view=chat', base).href);
    await page.locator('.chat-card[data-entity-id]').first().waitFor();
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 400)));
    await page.evaluate(async () => {
      const url = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((item) => new URL(item.name).pathname.endsWith(`/${name}`)).name;
      const { PREVIEW_REQUEST_HANDLERS } = await import(url('preview-transport.ts'));
      const { PREVIEW_NOT_HANDLED } = await import(url('preview-transport-runtime.ts'));
      const { buildPreviewManagedEntitiesResponse } = await import(
        url('preview-transport-system.ts')
      );
      window.__presentationRequests = [];
      window.__photoAbsent = false;
      window.__presentationCalls = 0;
      PREVIEW_REQUEST_HANDLERS.unshift(({ state, url, init }) => {
        if (url.pathname === '/chats') {
          const first = state.chats[0];
          const entities = Array.from({ length: 120 }, (_, index) => ({
            ...first,
            id: `demand-${index}`,
            title: `Chat demand-${index}`,
            favoriteTypes: [],
            avatarUrl: null,
          }));
          if (url.searchParams.get('includeRefreshState') !== '1') return entities;
          const response = buildPreviewManagedEntitiesResponse(entities, state.clock);
          response.snapshot.version = `demand-${Date.now()}`;
          return response;
        }
        if (url.pathname !== '/managed-entities/presentation') return PREVIEW_NOT_HANDLED;
        const body = JSON.parse(init.body);
        window.__presentationRequests.push(body.entityIds);
        window.__presentationCalls += 1;
        const loaded = window.__presentationCalls > 1;
        return {
          retryAfterMs: 1000,
          items: body.entityIds.map((id) => ({
            id,
            entityType: 'chat',
            title: loaded ? `Наше сообщество ${id.slice(7)}` : null,
            avatarUrl:
              loaded && !window.__photoAbsent
                ? `${location.origin}/presentation-test-photo.svg`
                : null,
            avatarState: window.__photoAbsent ? 'absent' : loaded ? 'present' : 'unknown',
            observedAt: loaded ? new Date().toISOString() : null,
            pending: !loaded,
          })),
        };
      });
    });
    await page.locator('.chats-command__refresh').click();
    const row = page.locator('.chat-card[data-entity-id="demand-0"]');
    await row.waitFor();
    await row.getByText('Наше сообщество 0', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-entity-id="demand-0"] .entity-avatar img');
      return img && img.complete && img.naturalWidth > 0;
    });
    assert.ok(imageAttempts >= 2, 'the same failed image URL must be retried');
    const requests = await page.evaluate(() => window.__presentationRequests);
    assert.ok(requests.every((ids) => ids.length > 0 && ids.length <= 32));
    assert.ok(new Set(requests.flat()).size < 120, 'hidden virtual rows must not be fetched');
    await page.evaluate(() => {
      window.__photoAbsent = true;
    });
    await page.locator('.chats-command__refresh').click();
    await page.waitForFunction(
      () => !document.querySelector('[data-entity-id="demand-0"] .entity-avatar img'),
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${platform} ${theme}: discovery settled, late title/photo, same-URL retry, explicit removal, bounded visible demand`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
}
