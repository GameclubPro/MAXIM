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
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Design tests require a local preview server');
const output = mkdtempSync(join(tmpdir(), 'maxim-moderation-design-'));
const browser = await chromium.launch();
try {
  for (const [width, height, theme] of [
    [320, 568, 'light'],
    [320, 568, 'dark'],
    [393, 851, 'light'],
    [393, 851, 'dark'],
    [1280, 900, 'light'],
    [1280, 900, 'dark'],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await installNativeVisualModeInitScript(context);
    await installMaxBridgeShimInitScript(
      context,
      { platform: width === 393 ? 'android' : 'ios' },
      { colorScheme: theme },
    );
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(new URL('chat/preview-chat/events?preview=1&device=iphone-se', base).href);
    await page.locator('.sanctions-workspace__row').first().waitFor();
    await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 0 });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    const sanctionsTop = (await page.locator('.sanctions-workspace__row').first().boundingBox()).y;
    if (width === 320) assert.ok(sanctionsTop <= 320, `sanctions start too low: ${sanctionsTop}`);
    const search = page.getByRole('searchbox', { name: 'Поиск ограничений' });
    await search.fill('несуществующий участник');
    await search.press('Enter');
    assert.equal(await search.evaluate((node) => node === document.activeElement), false);
    await page.getByText('Ограничений не найдено', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
    await page.locator('.sanctions-workspace__row').first().click();
    const panel = page.locator('.sanction-details');
    const primary = panel.getByRole('button', { name: 'Разрешить писать', exact: true });
    await primary.click({ trial: true });
    const footerBefore = await panel.locator('.settings-drilldown__footer').boundingBox();
    assert.ok(footerBefore.y + footerBefore.height <= height + 1);
    await panel.locator('.settings-drilldown__body').evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    const footerAfter = await panel.locator('.settings-drilldown__footer').boundingBox();
    assert.ok(Math.abs(footerBefore.y - footerAfter.y) <= 1, 'footer moved with body scroll');
    await page.screenshot({ path: join(output, `${width}-${theme}-detail.png`), fullPage: true });
    await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
    const tabs = page.getByRole('group', { name: 'Раздел статистики' });
    await tabs.getByRole('button', { name: 'Участники', exact: true }).click();
    await page.locator('.participants-roster__item').first().waitFor();
    const participantsTop = (await page.locator('.participants-roster__item').first().boundingBox())
      .y;
    if (width === 320)
      assert.ok(participantsTop <= 350, `participants start too low: ${participantsTop}`);
    await page.getByLabel('Роль участника', { exact: true }).selectOption('bots');
    await page.locator('.participants-roster__pill--bot').first().waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('.participants-roster__item').length ===
        document.querySelectorAll('.participants-roster__pill--bot').length,
    );
    assert.equal(await page.locator('.participants-roster__activity').count(), 0);
    await page.getByLabel('Роль участника', { exact: true }).selectOption('all');
    await page.getByLabel('Активность в MAX', { exact: true }).selectOption('30d');
    await page.locator('.participants-roster__activity--long').first().waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.participants-roster__activity')].every((node) =>
        node.classList.contains('participants-roster__activity--long'),
      ),
    );
    const longNameFits = await page
      .locator('.participants-roster__identity strong')
      .first()
      .evaluate((node) => {
        const text = node.textContent;
        node.textContent = 'Александра Константинопольская-Долгорукова';
        const fits = node.scrollWidth <= node.clientWidth + 1;
        node.textContent = text;
        return fits;
      });
    assert.equal(longNameFits, true, 'long participant name overflows');
    await page.screenshot({
      path: join(output, `${width}-${theme}-participants.png`),
      fullPage: true,
    });
    await tabs.getByRole('button', { name: 'События', exact: true }).click();
    await page.locator('.membership-feed__item').first().waitFor();
    const overlapping = await page.locator('.membership-feed__card').evaluateAll((cards) =>
      cards.some((card) => {
        const avatar = card.querySelector('.membership-feed__avatar')?.getBoundingClientRect();
        const name = card.querySelector('.membership-feed__name-link')?.getBoundingClientRect();
        return avatar && name && name.left < avatar.right + 3;
      }),
    );
    assert.equal(overlapping, false, 'event avatars overlap names');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px ${theme}: first rows ${Math.round(sanctionsTop)}/${Math.round(participantsTop)}, fixed footer, filters and aligned avatars`,
    );
    await context.close();
  }
  console.log(`Design screenshots: ${output}`);
} finally {
  await browser.close();
}
