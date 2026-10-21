import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3015/app/');
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
const output = mkdtempSync(join(tmpdir(), 'maxim-moderator-choice-'));
console.log(`Moderator browser: pid=${process.pid}, base=${base}, artifacts=${output}`);

async function assertInViewport(locator, label) {
  const geometry = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const viewport = window.visualViewport;
    return {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
      viewportTop: viewport?.offsetTop ?? 0,
      viewportLeft: viewport?.offsetLeft ?? 0,
      viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight),
      viewportRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth),
    };
  });
  assert.ok(
    geometry.top >= geometry.viewportTop - 1 &&
      geometry.left >= geometry.viewportLeft - 1 &&
      geometry.bottom <= geometry.viewportBottom + 1 &&
      geometry.right <= geometry.viewportRight + 1,
    `${label}: ${JSON.stringify(geometry)}`,
  );
}
try {
  for (const [width, height, platform, theme, entityType] of [
    [320, 568, 'ios', 'light', 'chat'],
    [393, 851, 'android', 'dark', 'chat'],
    [320, 568, 'ios', 'light', 'channel'],
    [393, 851, 'android', 'dark', 'channel'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(context, { platform }, { colorScheme: theme });
    await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
      route.fulfill({ contentType: 'application/javascript', body: '' }),
    );
    // FLAG: Exercise the 72px virtual row contract; grouped rows include a separator.
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
          if (result !== PREVIEW_NOT_HANDLED && context.method === 'GET') {
            if (context.url.pathname.endsWith('/settings-screen') && result.header) {
              window.__settingsHeaderTitle = result.header.title;
            }
            if (context.url.pathname === '/me' &&
              context.url.searchParams.get('entityType') === 'chat' &&
              context.url.searchParams.has('chatId') && window.__holdSettingsMe) {
              window.__heldSettingsMe = (window.__heldSettingsMe ?? 0) + 1;
              while (window.__holdSettingsMe && !context.init.signal?.aborted)
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          if (result !== PREVIEW_NOT_HANDLED && ['/chats', '/channels'].includes(context.url.pathname)) {
            const items = Array.isArray(result) ? result : result.items;
            if (items?.length) {
              const expanded = Array.from({ length: 100 }, (_, index) => ({
                ...items[index % items.length],
                id: index < items.length ? items[index].id : items[index % items.length].id + '-virtual-' + index,
              }));
              if (Array.isArray(result)) return expanded;
              return { ...result, items: expanded, snapshot: null, diff: undefined,
                refresh: { ...result.refresh, complete: true, userVisibleComplete: true,
                  backoffActive: false, nextPollAfterMs: 0 } };
            }
          }`,
        ),
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const botsLabel = entityType === 'chat' ? 'Боты чата' : 'Боты канала';
    await page.goto(new URL(`?preview=1&view=${entityType}`, base).href);
    const row = page.locator('.chat-grid--virtual .chat-card').first();
    await row.waitFor();
    await page.getByText('Статус списка: Список обновлён', { exact: true }).waitFor();
    await applyNativeVisualMode(page, { safeTop: 0, safeBottom: platform === 'android' ? 24 : 0 });
    assert.equal(
      await page.locator('.chat-card__moderator-control, .chat-card__moderator').count(),
      0,
    );
    await row.evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    const rowGeometry = await row.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        height: element.getBoundingClientRect().height,
        cssHeight: style.height,
        minHeight: style.minHeight,
        boxSizing: style.boxSizing,
        borderTop: style.borderTopWidth,
        borderBottom: style.borderBottomWidth,
      };
    });
    assert.equal(rowGeometry.height, 72, JSON.stringify(rowGeometry));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-home.png`,
      fullPage: false,
    });
    const settingsLink = row.locator('.chat-card__primary-link');
    const settingsUrl = new URL(await settingsLink.getAttribute('href'), page.url());
    assert.equal(settingsUrl.searchParams.get('preview'), '1');
    if (entityType === 'chat') {
      await page.evaluate(() => {
        window.__holdSettingsMe = true;
        window.__heldSettingsMe = 0;
        window.__settingsHeaderTitle = null;
      });
    }
    await settingsLink.click();
    await page.waitForURL(settingsUrl.href);
    const trigger = page.locator('[data-managed-entity-bots-trigger]');
    if (entityType === 'chat') {
      await page.waitForFunction(
        () => window.__heldSettingsMe > 0 && typeof window.__settingsHeaderTitle === 'string',
      );
      const headerTitle = await page.evaluate(() => window.__settingsHeaderTitle);
      await page
        .locator('.settings-home-sticky-header')
        .getByRole('heading', { name: headerTitle, exact: true })
        .waitFor();
      // FLAG: Let the independent header commit while /me still has no user identity.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await trigger.count(), 0, 'Bots must wait for the settings /me userId');
      assert.equal(await page.getByRole('dialog', { name: botsLabel, exact: true }).count(), 0);
      await page.screenshot({
        path: `${output}/${platform}-${theme}-${entityType}-waiting-me.png`,
        fullPage: false,
      });
      await page.evaluate(() => {
        window.__holdSettingsMe = false;
      });
    }
    await trigger.waitFor({ timeout: 12000 }).catch(async (error) => {
      await page.screenshot({
        path: `${output}/${platform}-${theme}-${entityType}-failed-settings.png`,
      });
      throw error;
    });
    assert.equal(await trigger.innerText(), botsLabel);
    if (entityType === 'chat') {
      console.log(
        `IDENTITY ${platform} ${theme} chat: header rendered while /me held, no trigger until userId resolved`,
      );
    }
    await assertInViewport(trigger, botsLabel);
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-settings.png`,
      fullPage: false,
    });
    await page.evaluate(async () => {
      const moduleUrl = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((entry) => new URL(entry.name).pathname.endsWith(`/${name}`))?.name ??
        new URL(`/src/lib/api/${name}`, location.origin).href;
      const { PREVIEW_REQUEST_HANDLERS } = await import(moduleUrl('preview-transport.ts'));
      const { PREVIEW_NOT_HANDLED } = await import(moduleUrl('preview-transport-runtime.ts'));
      const { handleModeratorPreviewRequest } = await import(
        moduleUrl('preview-transport-moderator.ts')
      );
      window.__moderatorPosts = [];
      window.__moderatorOperationReads = [];
      window.__loseModeratorReply = true;
      PREVIEW_REQUEST_HANDLERS.unshift(async (request) => {
        if (request.method === 'GET' && request.url.pathname.includes('/moderator/operations/')) {
          window.__moderatorOperationReads.push(request.segments.at(-1));
          return PREVIEW_NOT_HANDLED;
        }
        if (!request.url.pathname.endsWith('/moderator')) return PREVIEW_NOT_HANDLED;
        if (request.method === 'GET') {
          const result = await handleModeratorPreviewRequest(request);
          if (window.__singleModeratorCandidate) {
            return {
              ...result,
              candidates: result.candidates
                .filter((bot) => bot.key !== result.current.key && bot.selectable)
                .slice(0, 1),
            };
          }
          // FLAG: Six connected moderators must exercise overflow on both mobile viewports.
          return {
            ...result,
            candidates: [
              ...result.candidates,
              ...[
                ['5', 'Максимова 2', 'maximova'],
                ['6', 'Рэкс 2', 'rex'],
              ].map(([key, name, portrait]) => ({
                ...result.candidates[3],
                key: key.repeat(24),
                name,
                portrait,
              })),
            ],
          };
        }
        if (request.method !== 'POST') return PREVIEW_NOT_HANDLED;
        window.__moderatorPosts.push(JSON.parse(request.init.body));
        if (window.__moderatorFailure)
          throw Object.assign(new Error('Controlled API refusal'), {
            status: window.__moderatorFailure,
          });
        const result = await handleModeratorPreviewRequest(request);
        if (window.__loseModeratorReply) {
          window.__loseModeratorReply = false;
          await new Promise((resolve) => setTimeout(resolve, 250));
          throw new Error('Network response lost');
        }
        return result;
      });
    });
    await trigger.click();
    const sheet = page.getByRole('dialog', { name: botsLabel, exact: true });
    await sheet.getByText('Сейчас выбран', { exact: true }).waitFor();
    await sheet.evaluate((element) =>
      Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => undefined)),
      ),
    );
    const initialPublik = sheet
      .getByRole('region', { name: 'Публикации', exact: true })
      .getByRole('link', { name: /Публик/u });
    const scroller = sheet.locator('.managed-entity-bots-sheet__choices');
    await assertInViewport(sheet, 'Initial bots panel');
    await assertInViewport(initialPublik, 'Initial Publik link');
    const scrollGeometry = await scroller.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowY: getComputedStyle(element).overflowY,
    }));
    assert.ok(
      scrollGeometry.scrollHeight > scrollGeometry.clientHeight,
      JSON.stringify(scrollGeometry),
    );
    assert.match(scrollGeometry.overflowY, /^(auto|scroll)$/u);
    assert.ok(scrollGeometry.scrollWidth <= scrollGeometry.clientWidth + 1);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
      false,
    );
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-initial.png`,
      fullPage: false,
    });

    await scroller.hover();
    await page.mouse.wheel(0, scrollGeometry.scrollHeight);
    await page.waitForFunction(
      (element) => element.scrollTop >= element.scrollHeight - element.clientHeight - 1,
      await scroller.elementHandle(),
      { timeout: 5000 },
    );
    const bottomReached = await scroller.evaluate((element) => element.scrollTop);
    assert.ok(bottomReached > 0, 'The choices must actually scroll');
    await assertInViewport(scroller.locator('.home-moderator__option').last(), 'Last moderator');
    await assertInViewport(sheet, 'Scrolled bots panel');
    await assertInViewport(initialPublik, 'Publik while choices are scrolled');
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-scroll-bottom.png`,
      fullPage: false,
    });
    await page.mouse.wheel(0, -scrollGeometry.scrollHeight);
    await page.waitForFunction(
      (element) => element.scrollTop <= 1,
      await scroller.elementHandle(),
      { timeout: 5000 },
    );
    await assertInViewport(scroller.locator('.home-moderator__option').first(), 'First moderator');

    const closeButton = sheet.getByRole('button', { name: 'Закрыть ботов', exact: true });
    const lastFocusable = sheet.getByRole('button', { name: /Открыть бота в MAX/u });
    await closeButton.focus();
    await page.keyboard.press('Shift+Tab');
    await page.waitForFunction(
      (element) => document.activeElement === element,
      await lastFocusable.elementHandle(),
      { timeout: 5000 },
    );
    await page.keyboard.press('Tab');
    await page.waitForFunction(
      (element) => document.activeElement === element,
      await closeButton.elementHandle(),
      { timeout: 5000 },
    );
    for (let step = 0; step < 8; step += 1) {
      await page.keyboard.press('Tab');
      assert.equal(
        await sheet.evaluate((element) => element.contains(document.activeElement)),
        true,
        'Tab focus must stay inside the bots dialog',
      );
    }
    console.log(
      `LAYOUT ${platform} ${theme} ${entityType}: ${JSON.stringify({
        ...scrollGeometry,
        bottomReached,
        focusTrapped: true,
      })}`,
    );
    assert.equal(await sheet.getByRole('radio', { name: /Максимов 2/ }).isDisabled(), true);
    await sheet
      .getByRole('radio', { name: /^Максимова(?: Можно выбрать| Сейчас выбран)$/u })
      .check();
    assert.equal(await trigger.innerText(), botsLabel);
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 160)));
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-selection.png`,
      fullPage: false,
    });
    const button = sheet.getByRole('button', { name: 'Сменить бота', exact: true });
    await button.dblclick();
    await sheet.getByRole('button', { name: 'Проверить смену' }).waitFor();
    assert.equal((await page.evaluate(() => window.__moderatorPosts)).length, 1);
    await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
    await sheet.waitFor({ state: 'hidden' });
    // FLAG: Closing the sheet and returning keyboard focus finish on different frames.
    await page.waitForFunction(
      (element) => document.activeElement === element,
      await trigger.elementHandle(),
    );
    await trigger.click();
    await page.waitForFunction(() => window.__moderatorOperationReads.length === 1);
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await trigger.innerText(), botsLabel);
    assert.equal(
      await page.evaluate(() => window.__moderatorOperationReads[0]),
      await page.evaluate(() => window.__moderatorPosts[0].operationId),
    );
    assert.equal((await page.evaluate(() => window.__moderatorPosts)).length, 1);
    await trigger.click();
    await sheet.getByText('Сейчас выбран', { exact: true }).waitFor();
    assert.equal(
      await sheet
        .getByRole('radio', { name: /^Максимова(?: Можно выбрать| Сейчас выбран)$/u })
        .isChecked(),
      true,
    );
    assert.equal(
      await sheet.getByRole('button', { name: 'Сменить бота', exact: true }).isDisabled(),
      true,
    );
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    for (const [status, message] of [
      [403, 'Проверьте свои права администратора'],
      [429, 'Слишком много запросов'],
      [409, 'Выбор или права бота изменились'],
    ]) {
      await page.evaluate((status) => {
        window.__moderatorFailure = status;
      }, status);
      await trigger.click();
      const available = sheet.locator('input[type="radio"]:enabled:not(:checked)').first();
      await available.check();
      await sheet.getByRole('button', { name: 'Сменить бота', exact: true }).click();
      await sheet.getByRole('alert').filter({ hasText: message }).waitFor();
      assert.equal(await trigger.innerText(), botsLabel);
      assert.equal(await sheet.locator('input[type="radio"]:enabled').count(), 0);
      const request = await page.evaluate(() => window.__moderatorPosts.at(-1));
      await page.evaluate(() => {
        window.__moderatorFailure = 0;
      });
      await sheet.getByRole('button', { name: 'Проверить смену' }).click();
      await sheet.waitFor({ state: 'hidden' });
      assert.deepEqual(await page.evaluate(() => window.__moderatorPosts.at(-1)), request);
      assert.equal(await trigger.innerText(), botsLabel);
    }
    await page.evaluate(() => {
      window.__singleModeratorCandidate = true;
    });
    await trigger.click();
    await sheet.getByText('Сейчас выбран · пока недоступен', { exact: true }).waitFor();
    assert.equal(await sheet.getByRole('radio').count(), 1);
    assert.equal(await sheet.getByRole('radio').isDisabled(), false);
    await sheet.getByRole('radio').check();
    assert.equal(
      await sheet.getByRole('button', { name: 'Сменить бота', exact: true }).isDisabled(),
      false,
    );
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    await trigger.click();
    await sheet.getByText('Сейчас выбран · пока недоступен', { exact: true }).waitFor();
    const publicationsSection = sheet.getByRole('region', { name: 'Публикации', exact: true });
    const publications = publicationsSection.getByRole('link', { name: /Публик/u });
    assert.equal(await publicationsSection.getByRole('radio').count(), 0);
    const publikUrl = 'https://max.ru/se14088825_bot';
    assert.equal(await publications.getAttribute('href'), publikUrl);
    assert.equal(await sheet.getByRole('radio', { name: /Публик|Публикации/iu }).count(), 0);
    const settingsLocation = page.url();
    const postsBeforeHandoff = await page.evaluate(() => window.__moderatorPosts.length);
    await publications.click();
    await page.waitForFunction(
      (url) =>
        window.__MAXIM_VISUAL_BRIDGE_EVENTS__.some(
          (event) => event.type === 'openMaxLink' && event.payload.url === url,
        ),
      publikUrl,
    );
    assert.equal(page.url(), settingsLocation);
    assert.equal(await page.evaluate(() => window.__moderatorPosts.length), postsBeforeHandoff);
    assert.equal(await trigger.innerText(), botsLabel);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    await page.screenshot({
      path: `${output}/${platform}-${theme}-${entityType}-bots.png`,
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${platform} ${theme} ${entityType}: compact home, settings entry, viewport bounds, scrolling, focus trap, rights, repeated tap, lost response, reopen recovery, native Back, focus, 403/429/409 same-UUID recovery, unavailable current with one candidate, separate Publik handoff`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await stopChildProcess(server);
}
