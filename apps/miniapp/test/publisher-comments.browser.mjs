import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, devices, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';

const base =
  process.env.MINIAPP_PUBLISHER_TEST_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1:3014/app/'));
const output = await mkdtemp(path.join(tmpdir(), 'maxim-publisher-comments-'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_PUBLISHER_TEST_REUSE_SERVER === '1',
});
const browser = await chromium.launch();
async function select(locator) {
  if (!(await locator.isChecked())) await locator.click();
  await locator
    .page()
    .waitForFunction(
      (element) => element.checked && !element.disabled,
      await locator.elementHandle(),
    );
}

async function assertModuleAlignment(page, label) {
  const metrics = await page.locator('.publisher-entity-modules-page__modules').evaluate((list) => {
    const reference = list.querySelector(
      '.publisher-module-entry, .publisher-entity-module:not(.is-settings)',
    );
    const comments = list.querySelector('.publisher-comments-toggle');
    const icon = (node) =>
      node.querySelector('.publisher-entity-module__icon').getBoundingClientRect();
    const copy = (node) =>
      node.querySelector('.publisher-entity-module__copy, :scope > strong').getBoundingClientRect();
    const referenceAction = reference
      .querySelector('.publisher-entity-module__action, :scope > svg')
      .getBoundingClientRect();
    const commentsAction = comments.querySelector(':scope > svg').getBoundingClientRect();
    const bounds = comments.getBoundingClientRect();
    return {
      iconOffset: icon(comments).left - icon(reference).left,
      copyOffset: copy(comments).left - copy(reference).left,
      actionOffset:
        commentsAction.left +
        commentsAction.width / 2 -
        (referenceAction.left + referenceAction.width / 2),
      touchHeight: bounds.height,
      viewportOverflow: document.documentElement.scrollWidth - innerWidth,
      insideViewport: bounds.left >= 0 && bounds.right <= innerWidth + 1,
    };
  });
  assert.ok(
    Math.abs(metrics.iconOffset) <= 1 &&
      Math.abs(metrics.copyOffset) <= 1 &&
      Math.abs(metrics.actionOffset) <= 1 &&
      metrics.touchHeight >= 44 &&
      metrics.insideViewport &&
      metrics.viewportOverflow <= 1,
    `${label}: comments must align with neighboring module controls: ${JSON.stringify(metrics)}`,
  );
}

async function checkActualPublisherModuleLayout() {
  const layoutBrowser = await webkit.launch(captureBrowserLaunchOptions('webkit', base));
  try {
    for (const width of [393, 320, 280])
      for (const colorScheme of ['dark', 'light']) {
        const context = await layoutBrowser.newContext({
          ...devices['iPhone SE'],
          viewport: { width, height: 740 },
          screen: { width, height: 804 },
          colorScheme,
          locale: 'ru-RU',
          reducedMotion: 'reduce',
        });
        try {
          const externalRequests = [];
          await context.route('**/*', (route) => {
            const url = new URL(route.request().url());
            if (url.origin === 'https://st.max.ru' && url.pathname === '/js/max-web-app.js')
              return route.fulfill({ contentType: 'application/javascript', body: '' });
            if (url.origin !== new URL(base).origin || url.pathname.startsWith('/api/')) {
              if (url.pathname.endsWith('/system/miniapp-boot-trace'))
                return route.fulfill({ status: 204 });
              externalRequests.push(url.href);
              return route.abort('blockedbyclient');
            }
            return route.continue();
          });
          const profile = { platform: 'ios', safeTop: 20, safeBottom: 0 };
          await installMaxBridgeShimInitScript(context, profile, { colorScheme });
          await installNativeVisualModeInitScript(context);
          const page = await context.newPage();
          page.setDefaultTimeout(15_000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          for (const navigation of ['warm', 'cold']) {
            if (navigation === 'warm') {
              await page.goto(new URL('publik?preview=1&profile=publisher', base).href);
              await page.locator('.publisher-entity-row').first().waitFor();
              await page
                .getByRole('link', { name: /разделы/iu })
                .first()
                .click();
            } else {
              await page.goto(
                new URL('publisher/chat/preview-chat?preview=1&profile=publisher', base).href,
              );
            }
            await page.locator('.publisher-comments-toggle').waitFor();
            await applyNativeVisualMode(page, profile);
            await page.evaluate(() => document.fonts.ready);
            assert.equal(
              await page.locator('body').getAttribute('data-miniapp-profile'),
              'publisher',
            );
            const label = `WebKit ${width}px ${colorScheme} ${navigation}`;
            await page.screenshot({
              path: path.join(output, `modules-${width}-${colorScheme}-${navigation}.png`),
            });
            await assertModuleAlignment(page, label);
            await page.getByRole('button', { name: 'Комментарии', exact: true }).click();
            await page.getByRole('dialog', { name: 'Комментарии', exact: true }).waitFor();
            await page.keyboard.press('Escape');
            await page
              .getByRole('dialog', { name: 'Комментарии', exact: true })
              .waitFor({ state: 'hidden' });
            console.log(`PASS ${label}: aligned icons, labels and actions; comments open/close`);
          }
          assert.deepEqual(errors, []);
          assert.deepEqual(externalRequests, []);
        } finally {
          await context.close();
        }
      }
  } finally {
    await layoutBrowser.close();
  }
}
try {
  console.log(
    `Publisher comments checks: server ${server?.pid ?? 'reused'}, base ${base}, screenshots ${output}`,
  );
  await checkActualPublisherModuleLayout();
  for (const profile of [
    {
      name: 'iphone-se',
      device: devices['iPhone SE'],
      platform: 'ios',
      safeTop: 20,
      safeBottom: 0,
    },
    {
      name: 'android',
      device: devices['Pixel 7'],
      platform: 'android',
      safeTop: 24,
      safeBottom: 0,
    },
    {
      name: 'desktop',
      device: { viewport: { width: 1280, height: 900 } },
      platform: 'web',
      safeTop: 0,
      safeBottom: 0,
    },
  ])
    for (const colorScheme of ['light', 'dark']) {
      const context = await browser.newContext({
        ...profile.device,
        colorScheme,
        reducedMotion: 'reduce',
        locale: 'ru-RU',
      });
      await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
        route.fulfill({ body: '' }),
      );
      await context.route('**/src/main.tsx', (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: `import ${JSON.stringify(new URL('test/publisher-comments.fixture.tsx', base).href)};`,
        }),
      );
      await installMaxBridgeShimInitScript(context, profile, { colorScheme });
      await installNativeVisualModeInitScript(context);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(base);
      const toggle = page.getByRole('button', { name: 'Комментарии', exact: true });
      await toggle.waitFor();
      await applyNativeVisualMode(page, profile);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(await page.getByRole('radio').count(), 0);
      assert.equal(await page.getByLabel('Включить комментарии', { exact: true }).count(), 0);
      await page.screenshot({
        path: path.join(output, `${profile.name}-${colorScheme}-collapsed.png`),
      });
      await toggle.click();
      const workspace = page.getByRole('dialog', { name: 'Комментарии', exact: true });
      await workspace.waitFor();
      assert.equal(
        await page
          .locator('.publisher-entity-modules-page input[aria-label="Включить комментарии"]')
          .count(),
        0,
      );
      const screen = await workspace.boundingBox();
      assert.ok(
        screen.y <= 1 && screen.height >= profile.device.viewport.height - 1,
        JSON.stringify(screen),
      );
      await select(page.getByLabel('Включить комментарии', { exact: true }));
      await select(page.getByLabel('Комментарии для сообщений администраторов', { exact: true }));
      const replacement = page.getByRole('radio', { name: 'От имени бота', exact: true });
      await select(replacement);
      await page.waitForFunction(
        () =>
          window.publisherCommentsTest.changes.at(-1)?.chatComments
            ?.commentsReplaceOriginalEnabled === true,
      );
      await page.keyboard.press('Escape');
      await workspace.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Обновить данные', exact: true }).click();
      await toggle.click();
      await workspace.waitFor();
      assert.equal(await replacement.isChecked(), true);
      await page.screenshot({
        path: path.join(output, `${profile.name}-${colorScheme}-workspace.png`),
      });
      const metrics = await page.locator('.publisher-comments-workspace').evaluate((element) => ({
        overflow: element.scrollWidth - element.clientWidth,
        outside: [...element.querySelectorAll('label, button')].some((control) => {
          const rect = control.getBoundingClientRect();
          return rect.left < 0 || rect.right > innerWidth + 1;
        }),
      }));
      assert.ok(metrics.overflow <= 1 && !metrics.outside, JSON.stringify(metrics));
      await page.getByRole('button', { name: 'О режиме «От имени бота»', exact: true }).click();
      const info = page.getByRole('dialog', { name: 'От имени бота', exact: true });
      await info.waitFor();
      const dialogLayout = await info.evaluate((dialog) => {
        const rect = dialog.getBoundingClientRect();
        const copy = dialog.querySelector('p');
        const text = copy.getBoundingClientRect();
        return {
          inside:
            rect.left >= 0 &&
            rect.right <= innerWidth + 1 &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight + 1,
          textVisible: copy.contains(document.elementFromPoint(text.left + 5, text.top + 5)),
          overflow: dialog.scrollWidth - dialog.clientWidth,
        };
      });
      assert.ok(
        dialogLayout.inside && dialogLayout.textVisible && dialogLayout.overflow <= 1,
        JSON.stringify(dialogLayout),
      );
      await page.screenshot({ path: path.join(output, `${profile.name}-${colorScheme}-info.png`) });
      await page.keyboard.press('Escape');
      await info.waitFor({ state: 'hidden' });
      await workspace.waitFor();
      await page.evaluate(() => window.publisherCommentsTest.failNext());
      await page.getByRole('radio', { name: 'Кнопка к сообщению', exact: true }).click();
      await page.getByText('Не удалось сохранить', { exact: true }).waitFor();
      assert.equal(await replacement.isChecked(), true);
      await page.keyboard.press('Escape');
      await workspace.waitFor({ state: 'hidden' });
      await toggle.click();
      await workspace.waitFor();
      assert.equal(await replacement.isChecked(), true);
      await page.goto(`${base}?channel=1`);
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      await toggle.click();
      await page.getByRole('button', { name: 'О комментариях канала', exact: true }).click();
      const channelInfo = page.getByRole('dialog', { name: 'Комментарии канала', exact: true });
      await channelInfo.waitFor();
      await page.keyboard.press('Escape');
      await channelInfo.waitFor({ state: 'hidden' });
      await page.keyboard.press('Escape');
      await workspace.waitFor({ state: 'hidden' });

      if (profile.device.viewport.width <= 600) {
        const suggestionsEntry = page.getByRole('button', { name: 'Предложения', exact: true });
        assert.equal((await suggestionsEntry.textContent()).trim(), 'Предложения');
        assert.equal(
          await page.locator('.publisher-entity-modules-page__modules input').count(),
          0,
          'mobile module navigation must not contain switches',
        );
        await suggestionsEntry.click();
        const suggestions = page.getByRole('dialog', { name: 'Предложения', exact: true });
        await suggestions.waitFor();
        const controlledId = await suggestionsEntry.getAttribute('aria-controls');
        assert.ok(controlledId);
        assert.equal(await suggestions.locator(`[id="${controlledId}"]`).count(), 1);
        const master = suggestions.locator('.settings-drilldown__header input[type="checkbox"]');
        const subscription = suggestions.getByRole('checkbox', {
          name: 'Требовать подписку',
          exact: true,
        });
        const deletion = suggestions.getByRole('checkbox', {
          name: 'Удалять посты после отписки',
          exact: true,
        });
        assert.equal(await subscription.isDisabled(), !(await master.isChecked()));
        await select(master);
        await select(subscription);
        await select(deletion);
        const changes = await page.evaluate(() => window.publisherCommentsTest.changes);
        for (const key of [
          'channelSuggestionsEnabled',
          'channelSuggestionsRequireSubscription',
          'channelSuggestionsDeleteOnUnsubscribe',
        ]) {
          assert.ok(
            changes.some((change) => change[key] === true),
            `${key} must reach the API`,
          );
        }
        assert.ok(changes.every((change) => Number.isInteger(change.expectedRevision)));
        await page.screenshot({
          path: path.join(output, `${profile.name}-${colorScheme}-suggestions.png`),
        });
        await page.evaluate(() => window.publisherCommentsTest.failNext());
        await master.click();
        await page.getByText('Не удалось сохранить', { exact: true }).waitFor();
        await page.waitForFunction(() => {
          const input = document.querySelector(
            '.publisher-suggestions-workspace .settings-drilldown__header input',
          );
          return input?.checked && !input.disabled;
        });
        await page.keyboard.press('Escape');
        await suggestions.waitFor({ state: 'hidden' });
        assert.equal(
          await suggestionsEntry.evaluate((node) => node === document.activeElement),
          true,
        );
        await suggestionsEntry.click();
        await suggestions.waitFor();
        assert.equal(await master.isChecked(), true);
        assert.equal(await subscription.isChecked(), true);
        assert.equal(await deletion.isChecked(), true);
      } else {
        assert.equal(
          await page.getByRole('button', { name: 'Предложения', exact: true }).count(),
          0,
          'desktop keeps its direct module switch',
        );
        assert.equal(await page.getByRole('checkbox', { name: /предложения$/u }).isVisible(), true);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(`Publisher comments browser checks passed. Screenshots: ${output}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
