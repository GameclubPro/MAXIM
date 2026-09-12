import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = process.env.MINIAPP_GIVEAWAY_TEST_BASE ?? 'http://127.0.0.1:5174/app/';
const browser = await chromium.launch({ headless: true });
const viewports = [
  { width: 320, height: 568 },
  { width: 393, height: 852 },
  { width: 412, height: 915 },
  { width: 1440, height: 900 },
];

async function assertParticipationLayout(page) {
  const layout = await page.locator('.giveaway-page').evaluate((element) => {
    const content = element.querySelector('.giveaway-page__content');
    const footer = element.querySelector('footer');
    const primary = element.querySelector('.giveaway-page__primary');
    return {
      horizontalOverflow: [...element.querySelectorAll('*'), element].some(
        (child) => child.clientWidth > 0 && child.scrollWidth > child.clientWidth + 1,
      ),
      contentBottom: content.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      primaryBottom: primary.getBoundingClientRect().bottom,
      primaryTop: primary.getBoundingClientRect().top,
      height: window.innerHeight,
    };
  });
  assert.equal(layout.horizontalOverflow, false, JSON.stringify(layout));
  assert.ok(layout.contentBottom <= layout.footerTop + 1, 'Footer must not cover content');
  assert.ok(layout.primaryTop >= 0 && layout.primaryBottom <= layout.height);
}

try {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(new URL('test/browser/giveaway.html', base).href);
  const main = page.locator('.giveaway-page');
  const primary = main.locator('.giveaway-page__primary');
  await main.getByRole('button', { name: 'Проверить и участвовать' }).waitFor();
  assert.equal(await main.getByText('Не проверено', { exact: true }).count(), 2);
  assert.equal(await main.getByText('Скрытый приз').count(), 0);
  assert.equal(await main.getByText('Не дублировать приз').count(), 0);
  await primary.evaluate((element) => {
    element.click();
    element.click();
  });
  await main.locator('.giveaway-page__verification.is-checking').waitFor();
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.enters), 1);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'missing';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Осталось подписаться' }).waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '1');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await main.getByRole('button', { name: 'Открыть Партнёр' }).click();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.enters), 3);
  assert.equal(await page.evaluate(() => window.giveawayTest.opened), true);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'pending';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Заявка ожидает проверки' }).waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '0');
  await page.evaluate(() => {
    window.giveawayTest.mode = 'error';
  });
  await primary.click();
  await main.getByRole('alert').waitFor();
  assert.equal(await main.getByRole('progressbar').getAttribute('aria-valuenow'), '0');
  await page.evaluate(() => window.giveawayTest.longConditions());
  await main.getByRole('button', { name: /Открыть Дополнительный канал 20 /u }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.maxTheme = value;
    }, theme);
    for (const viewport of [...viewports, { width: 375, height: 320 }]) {
      await page.setViewportSize(viewport);
      await assertParticipationLayout(page);
      const lastCondition = main.locator('.giveaway-page__condition-list li').last();
      await lastCondition.scrollIntoViewIfNeeded();
      const row = await lastCondition.boundingBox();
      const footer = await main.locator('footer').boundingBox();
      assert.ok(row.y + row.height <= footer.y + 1, 'Last condition must remain reachable');
    }
  }
  await page.setViewportSize(viewports[1]);
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  for (const mode of ['read-error', 'public-error']) {
    await page.evaluate((value) => {
      window.giveawayTest.mode = value;
      window.giveawayTest.refresh();
    }, mode);
    await main.getByRole('alert').waitFor();
    assert.equal(await main.getAttribute('data-tone'), 'error');
    assert.equal(await main.locator('.giveaway-page__verification.is-verified').count(), 0);
    await page.evaluate(() => {
      window.giveawayTest.mode = 'verified';
    });
    await primary.click();
    await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
    assert.equal(await main.getByRole('alert').count(), 0);
  }
  await page.evaluate(() => window.giveawayTest.setScenario('winner'));
  await main.getByRole('button', { name: 'Подтвердить выигрыш' }).waitFor();
  assert.equal(await main.getAttribute('data-tone'), 'winner');
  assert.equal(await main.locator('.giveaway-page__ticket').count(), 0);
  await main.getByRole('button', { name: 'К опубликованным итогам' }).click();
  assert.equal(await page.evaluate(() => window.giveawayTest.openedUrl), 'https://max.ru/results');
  await primary.click();
  await main.getByRole('heading', { name: 'Выигрыш подтверждён' }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.claims), 1);
  await page.evaluate(() => window.giveawayTest.setScenario('expired'));
  await main.getByRole('heading', { name: 'Срок подтверждения истёк' }).waitFor();
  assert.equal(await main.getByRole('button', { name: 'Подтвердить выигрыш' }).count(), 0);
  assert.equal(await main.getAttribute('data-tone'), 'muted');
  await page.evaluate(() => window.giveawayTest.setScenario('canceled'));
  await main.getByRole('heading', { name: 'Розыгрыш отменён' }).waitFor();
  assert.equal(await main.locator('.giveaway-page__verification.is-verified').count(), 0);

  for (const theme of ['light', 'dark']) {
    for (const viewport of viewports.slice(0, 3)) {
      const context = await browser.newContext({ viewport, colorScheme: theme });
      await installNativeVisualModeInitScript(context);
      const profile = {
        safeTop: 0,
        safeBottom: 34,
        platform: viewport.width === 412 ? 'android' : 'ios',
      };
      await installMaxBridgeShimInitScript(context, profile, { colorScheme: theme });
      const editorPage = await context.newPage();
      editorPage.on('pageerror', (error) => errors.push(error.message));
      await editorPage.goto(
        new URL('chat/preview-chat/settings?preview=1&device=iphone&focus=giveaway', base).href,
      );
      const card = editorPage.locator('.managed-giveaway');
      await card.waitFor();
      await applyNativeVisualMode(editorPage, profile);
      await card
        .getByRole('button', { name: /^(Редактировать|Продолжить)/u })
        .first()
        .click();
      for (const step of ['basics', 'conditions', 'prizes']) {
        await editorPage.locator(`.managed-giveaway--step-${step}`).waitFor();
        const heading = card.locator('.managed-giveaway__hero-title-row h2');
        await heading.waitFor();
        const headingBounds = await heading.boundingBox();
        const panelHeader = await editorPage.locator('.settings-drilldown__header').boundingBox();
        assert.ok(
          headingBounds.y >= panelHeader.y + panelHeader.height - 1,
          'New step must start below the panel header',
        );
        const dock = card.locator('.managed-giveaway__action-dock');
        await dock.scrollIntoViewIfNeeded();
        const geometry = await card.evaluate((element) => {
          const dock = element.querySelector('.managed-giveaway__action-dock');
          const dockBounds = dock.getBoundingClientRect();
          const contentBounds = element
            .querySelector('.managed-giveaway__step-stage')
            .getBoundingClientRect();
          return {
            dockTop: dockBounds.top,
            contentBottom: contentBounds.bottom,
            position: getComputedStyle(dock).position,
            overflow: element.scrollWidth > element.clientWidth + 1,
          };
        });
        assert.equal(geometry.position, 'static');
        assert.equal(geometry.overflow, false);
        assert.ok(
          geometry.dockTop >= geometry.contentBottom - 1,
          'Step navigation must not overlap fields',
        );
        if (step !== 'prizes') {
          await dock
            .getByRole('button', { name: step === 'basics' ? 'К условиям' : 'К призам' })
            .click();
        }
      }
      await context.close();
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Giveaway browser checks passed: participation, errors/retry, claim/results, long conditions, five viewport sizes, light/dark, and editor navigation without overlap.',
  );
} finally {
  await browser.close();
}
