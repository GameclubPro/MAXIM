import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.MINIAPP_GIVEAWAY_TEST_BASE ?? 'http://127.0.0.1:5174/app/';
const browser = await chromium.launch({ headless: true });
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
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 393, height: 852 },
    { width: 412, height: 915 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    const bounds = await primary.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height);
    assert.ok(await main.evaluate((element) => element.scrollWidth <= element.clientWidth));
  }
  await page.evaluate(() => {
    window.giveawayTest.mode = 'verified';
  });
  await primary.click();
  await main.getByRole('heading', { name: 'Вы участвуете', exact: true }).waitFor();
  await page.evaluate(() => window.giveawayTest.setScenario('winner'));
  await main.getByRole('button', { name: 'Подтвердить выигрыш' }).waitFor();
  await primary.click();
  await main.getByRole('heading', { name: 'Выигрыш подтверждён' }).waitFor();
  assert.equal(await page.evaluate(() => window.giveawayTest.claims), 1);
  await page.evaluate(() => window.giveawayTest.setScenario('expired'));
  await main.getByRole('heading', { name: 'Срок подтверждения истёк' }).waitFor();
  assert.equal(await main.getByRole('button', { name: 'Подтвердить выигрыш' }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Giveaway browser checks passed: conditions, single-flight, MAX return, pending/error, claim/expiry, four viewport sizes.',
  );
} finally {
  await browser.close();
}
