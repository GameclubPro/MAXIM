import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const output = await mkdtemp('/tmp/maxim-bottom-navigation-');
const server = await ensureMiniappDevServer(base);
const failures = [];
console.log(`Screenshots: ${output}`);

async function geometry(page) {
  return page.locator('.bottom-nav').evaluate((nav) => {
    const rect = nav.getBoundingClientRect();
    const viewportBottom =
      (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight);
    return { gap: viewportBottom - rect.bottom, top: rect.top, height: rect.height };
  });
}

async function setSafeBottom(page, safeBottom) {
  await page.evaluate((value) => {
    document.documentElement.style.setProperty('--app-safe-bottom', `${value}px`);
    document.documentElement.style.setProperty('--safe-bottom', `${value}px`);
    window.dispatchEvent(new Event('resize'));
  }, safeBottom);
  await page.evaluate(() => new Promise(requestAnimationFrame));
}

try {
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({
      env: { ...process.env, GIO_USE_PROXY_RESOLVER: 'dummy' },
    });
    try {
      for (const [width, height] of [
        [320, 568],
        [393, 749],
        [412, 811],
      ]) {
        for (const colorScheme of ['light', 'dark']) {
          for (const profile of ['moderation', 'publisher']) {
            const name = `${engine.name()}-${width}-${colorScheme}-${profile}`;
            const context = await browser.newContext({
              viewport: { width, height },
              isMobile: true,
              hasTouch: true,
              colorScheme,
              reducedMotion: 'reduce',
            });
            try {
              await context.route('**/*', (route) =>
                new URL(route.request().url()).origin === new URL(base).origin
                  ? route.continue()
                  : route.abort(),
              );
              await installMaxBridgeShimInitScript(
                context,
                { platform: width === 412 ? 'android' : 'ios' },
                { colorScheme },
              );
              await installNativeVisualModeInitScript(context);
              const page = await context.newPage();
              await page.goto(`${base}?preview=1&profile=${profile}`);
              await page.locator('.bottom-nav').waitFor();
              await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 0 });
              await page.evaluate(() => document.fonts.ready);
              const baseline = await geometry(page);
              assert.ok(
                baseline.gap >= 0 && baseline.gap <= 16,
                `${name}: baseline ${JSON.stringify(baseline)}`,
              );
              for (const safeBottom of [24, 34, 48, 300, 34, 0]) {
                await setSafeBottom(page, safeBottom);
                const actual = await geometry(page);
                const expectedGap = baseline.gap + Math.min(safeBottom, 48);
                if (
                  Math.abs(actual.gap - expectedGap) > 1 ||
                  actual.height > 96 ||
                  actual.top < 0
                ) {
                  const failure = `${name} safe=${safeBottom}: expected gap ${expectedGap}, got ${JSON.stringify(actual)}`;
                  failures.push(failure);
                  console.error(failure);
                }
                assert.equal(
                  await page.evaluate(() =>
                    getComputedStyle(document.documentElement)
                      .getPropertyValue('--app-safe-bottom')
                      .trim(),
                  ),
                  `${safeBottom}px`,
                );
                if (safeBottom === 34 || safeBottom === 300)
                  await page.screenshot({ path: `${output}/${name}-${safeBottom}.png` });
              }

              // Model a native host whose fixed containing block already excludes the bottom bar.
              await setSafeBottom(page, 34);
              await page.evaluate(() => {
                document.body.style.cssText = `transform:translateZ(0);height:${innerHeight - 34}px;min-height:0`;
                Object.defineProperty(visualViewport, 'height', {
                  configurable: true,
                  value: innerHeight - 34,
                });
                window.dispatchEvent(new Event('resize'));
                visualViewport.dispatchEvent(new Event('resize'));
              });
              const inset = await geometry(page);
              if (Math.abs(inset.gap - baseline.gap) > 1)
                failures.push(`${name}: native area counted twice ${JSON.stringify(inset)}`);

              await page.evaluate(() => {
                document.body.style.cssText = '';
                Object.defineProperty(visualViewport, 'height', {
                  configurable: true,
                  value: innerHeight,
                });
                window.dispatchEvent(new Event('resize'));
                visualViewport.dispatchEvent(new Event('resize'));
              });
              await page.getByRole('searchbox').first().focus();
              await page.evaluate(() => {
                Object.defineProperty(visualViewport, 'height', {
                  configurable: true,
                  value: innerHeight - 280,
                });
                visualViewport.dispatchEvent(new Event('resize'));
              });
              await page.locator('.bottom-nav').waitFor({ state: 'hidden' });
              await page.getByRole('searchbox').first().blur();
              await page.evaluate(() => {
                Object.defineProperty(visualViewport, 'height', {
                  configurable: true,
                  value: innerHeight,
                });
                visualViewport.dispatchEvent(new Event('resize'));
              });
              await page.locator('.bottom-nav').waitFor({ state: 'visible' });
              const restored = await geometry(page);
              assert.ok(
                Math.abs(restored.gap - baseline.gap - 34) <= 1,
                `${name}: keyboard close ${JSON.stringify(restored)}`,
              );
              await setSafeBottom(page, 300);
              const last = page
                .locator(profile === 'publisher' ? '.publisher-entity-row__main' : '.chat-card')
                .last();
              await last.evaluate((node) =>
                node.scrollIntoView({ block: 'start', behavior: 'instant' }),
              );
              const row = await last.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, navTop: nav.top };
              });
              if (row.top < 0 || row.bottom > row.navTop + 1)
                failures.push(`${name}: last catalog row is covered ${JSON.stringify(row)}`);
              if (width === 393 && colorScheme === 'light' && profile === 'moderation') {
                await page.goto(`${base}chat/preview-chat/settings?preview=1`);
                await page
                  .getByRole('searchbox', { name: 'Найти настройку', exact: true })
                  .waitFor();
                await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 300 });
                assert.equal(await page.locator('.bottom-nav').count(), 0);
                await page.goBack();
                await page.locator('.chat-card').first().waitFor();
                await applyNativeVisualMode(page, { safeTop: 0, safeBottom: 300 });
                await page
                  .locator('.bottom-nav')
                  .getByRole('link', { name: 'Каналы', exact: true })
                  .click();
                await page
                  .locator('.bottom-nav a[aria-current="page"]')
                  .filter({ hasText: 'Каналы' })
                  .waitFor();
                if ((await geometry(page)).gap > 64)
                  failures.push(`${name}: cross-route navigation raised`);
              }
              console.log(`[bottom-navigation] ${name}: checked`);
            } finally {
              await context.close();
            }
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  assert.deepEqual(
    failures,
    [],
    'Navigation must stay near the visible bottom without consuming an oversized safe area',
  );
  console.log(`Screenshots: ${output}`);
} finally {
  await stopChildProcess(server);
}
