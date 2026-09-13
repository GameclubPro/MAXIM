import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Home stability tests require a local Vite server');
}
const output = mkdtempSync(join(tmpdir(), 'maxim-home-stability-'));
const browser = await chromium.launch();
try {
  for (const [width, height, platform, safeBottom] of [
    [320, 568, 'ios', 0],
    [390, 844, 'ios', 34],
    [393, 851, 'android', 24],
    [1280, 900, 'desktop', 0],
  ]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(new URL('?preview=1&view=chat', base).href);
      const rows = page.locator('.chat-card[data-entity-id]');
      const ids = () => rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.entityId));
      const settled = async (entityType) => {
        await page.locator(`.chats-home--${entityType}`).waitFor();
        await rows.first().waitFor();
        await page.getByText('Статус списка: Список обновлён', { exact: true }).waitFor();
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
      };
      await settled('chat');
      await applyNativeVisualMode(page, { safeTop: 0, safeBottom });
      // Cover multiple ordinary rows and multiple favorites in the same category.
      await page.evaluate(async () => {
        const moduleUrl = (name) =>
          performance
            .getEntriesByType('resource')
            .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`)).name;
        const { PREVIEW_REQUEST_HANDLERS } = await import(moduleUrl('preview-transport.ts'));
        const { PREVIEW_NOT_HANDLED } = await import(moduleUrl('preview-transport-runtime.ts'));
        const { buildPreviewManagedEntitiesResponse } = await import(
          moduleUrl('preview-transport-system.ts')
        );
        window.__homeReorderedResponses = 0;
        window.__homeReverseResponses = false;
        const initialized = new Set();
        PREVIEW_REQUEST_HANDLERS.unshift(({ state, url }) => {
          const key =
            url.pathname === '/chats' ? 'chats' : url.pathname === '/channels' ? 'channels' : null;
          if (!key) return PREVIEW_NOT_HANDLED;
          if (!initialized.has(key)) {
            initialized.add(key);
            const first = state[key][0];
            state[key].push(
              ...Array.from({ length: 4 }, (_, index) => ({
                ...first,
                id: `${key}-extra-${index}`,
                title: `${first.title} ${index + 2}`,
                favoriteTypes: index < 2 ? first.favoriteTypes : [],
              })),
            );
          }
          window.__homeReorderedResponses += 1;
          const items = window.__homeReverseResponses ? [...state[key]].reverse() : state[key];
          if (url.searchParams.get('includeRefreshState') !== '1') return structuredClone(items);
          const response = buildPreviewManagedEntitiesResponse(items, state.clock);
          response.snapshot.version = `reordered-${window.__homeReorderedResponses}`;
          return response;
        });
      });
      await page.locator('.chats-command__refresh').click();
      await page.waitForFunction(() => document.querySelectorAll('.chat-card').length === 6);
      await settled('chat');
      const chats = await ids();
      await page.locator('.bottom-nav').getByText('Каналы', { exact: true }).click();
      await settled('channel');
      const channels = await ids();
      assert.equal(channels.length, 6);
      await page.evaluate(() => {
        window.__homeReverseResponses = true;
      });

      for (let pass = 0; pass < 2; pass += 1) {
        for (const [label, entityType, expected] of [
          ['Чаты', 'chat', chats],
          ['Каналы', 'channel', channels],
        ]) {
          await page.locator('.bottom-nav').getByText(label, { exact: true }).click();
          await settled(entityType);
          const responsesBefore = await page.evaluate(() => window.__homeReorderedResponses);
          await page.locator('.chats-command__refresh').click();
          await page.waitForFunction(
            (count) => window.__homeReorderedResponses > count,
            responsesBefore,
          );
          await settled(entityType);
          assert.deepEqual(await ids(), expected, `${label} moved after tab switch`);
          await rows.first().locator('.chat-card__primary-link').click();
          await page.waitForURL(/\/settings/);
          await page
            .locator(
              entityType === 'chat'
                ? 'body.settings-home-page-open'
                : 'body.channel-settings-page-open',
            )
            .waitFor();
          await page.goBack();
          await settled(entityType);
          assert.deepEqual(await ids(), expected, `${label} moved after settings return`);
        }
      }
      assert.ok(await page.evaluate(() => window.__homeReorderedResponses >= 4));
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map((animation) => animation.finished.catch(() => undefined)),
        ),
      );

      for (const [visualInset, layoutInset] of [
        [0, 0],
        [safeBottom, 0],
        [0, safeBottom],
        [safeBottom, safeBottom],
      ]) {
        const result = await page.evaluate(
          ({ visualInset, layoutInset }) => {
            const root = document.documentElement;
            root.style.setProperty('--app-visual-viewport-bottom', `${visualInset}px`);
            root.style.setProperty('--app-layout-viewport-bottom', `${layoutInset}px`);
            const nav = document.querySelector('.bottom-nav');
            return {
              bottom: parseFloat(getComputedStyle(nav).bottom),
              offset: parseFloat(getComputedStyle(nav).getPropertyValue('--bottom-nav-offset')),
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
            };
          },
          { visualInset, layoutInset },
        );
        assert.equal(
          result.bottom,
          result.offset + Math.max(0, safeBottom - Math.max(visualInset, layoutInset)),
        );
        assert.equal(result.overflow, false);
      }
      await page.screenshot({
        path: join(output, `${width}-${theme}-inset-home.png`),
        fullPage: true,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.screenshot({ path: join(output, `${width}-${theme}-home.png`), fullPage: true });

      const search = page.locator('input[type="search"]');
      await search.fill('No matching entity');
      await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: { width: innerWidth, height: innerHeight - 300, offsetTop: 0, offsetLeft: 0 },
        });
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.bottom-nav')).opacity === '0',
      );
      await search.fill('');
      await search.blur();
      await page.evaluate(() => {
        delete window.visualViewport;
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(
        () => getComputedStyle(document.querySelector('.bottom-nav')).opacity === '1',
      );
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${width}px ${theme}: stable chats/channels, settings return, bottom insets, keyboard`,
      );
      await context.close();
    }
  }
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
