import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
const base =
  process.env.MINIAPP_TEST_BASE_URL ?? (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const server = await ensureMiniappDevServer(base, {
  reuseServer: process.env.MINIAPP_TEST_REUSE_SERVER === '1',
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/report-journal-test', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from '/app/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/app/test/fixtures/report-journal-harness.tsx');</script></body></html>`,
    }),
  );
  await page.goto(new URL('report-journal-test', base).href);
  await page.getByText('Сбор голосов', { exact: true }).waitFor();
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'Ещё', exact: true }).click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('.reports-journal__item').length === count,
      40 + i * 20,
    );
  }
  const before = await page.evaluate(
    () => window.reportJournalTest.requests.filter((request) => request.kind === 'older').length,
  );
  await page.waitForTimeout(10_500);
  assert.equal(
    await page.evaluate(
      () => window.reportJournalTest.requests.filter((request) => request.kind === 'older').length,
    ),
    before,
  );
  await page.getByText('Сбор голосов', { exact: true }).click();
  await page.getByRole('heading', { name: 'Участники', exact: true }).waitFor();
  await page.evaluate(() => window.reportJournalTest.complete());
  await page.getByRole('button', { name: 'Обновить жалобы', exact: true }).click();
  await page
    .getByRole('button', { name: 'Отклонить жалобы', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(
    await page.getByRole('button', { name: 'Отклонить жалобы', exact: true }).count(),
    0,
  );
  assert.match(await page.locator('.reports-outcomes').innerText(), /^1/u);
  const detailCount = await page.evaluate(
    () => window.reportJournalTest.requests.filter((request) => request.kind === 'detail').length,
  );
  await page.waitForTimeout(10_500);
  assert.equal(
    await page.evaluate(
      () => window.reportJournalTest.requests.filter((request) => request.kind === 'detail').length,
    ),
    detailCount,
  );
  await page.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('ACTIVE');
  await page.getByText('Жалоб по выбранным условиям пока нет.', { exact: true }).waitFor();
  assert.equal(await page.locator('.reports-journal__item').count(), 0);
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await page.locator('.reports-journal__item').first().waitFor();
  await page.evaluate(() => window.reportJournalTest.addCollecting());
  await page.evaluate(() => window.reportJournalTest.refreshHead());
  await page.getByText('Сбор голосов', { exact: true }).waitFor();
  await page.evaluate(() => window.reportJournalTest.holdNextDetail());
  await page.locator('.reports-journal__summary').first().click();
  await page.waitForFunction(() => window.reportJournalTest.heldStatus() === 'COLLECTING');
  await page.evaluate(() => window.reportJournalTest.complete());
  await page.evaluate(() => window.reportJournalTest.refreshHead());
  await page
    .locator('.reports-journal__item')
    .first()
    .getByText('Выполнено', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Отклонить жалобы', exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.reportJournalTest.releaseDetail());
  await page.getByRole('heading', { name: 'Участники', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Отклонить жалобы', exact: true }).count(),
    0,
  );
  assert.equal(await page.getByText('Сбор голосов', { exact: true }).count(), 0);
  assert.match(await page.locator('.reports-outcomes').innerText(), /^1/u);
  await page.evaluate(() => window.reportJournalTest.fail(true));
  await page.getByRole('button', { name: 'Обновить жалобы', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Не удалось загрузить жалобы' }).waitFor();
  await page.evaluate(() => window.reportJournalTest.fail(false));
  await page.getByRole('button', { name: 'Обновить жалобы', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Не удалось загрузить жалобы' })
    .waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: bounded polling, terminal detail, coherent refresh, server filters, delayed response, error recovery, 320px layout',
  );
} finally {
  await browser.close();
  await stopChildProcess(server);
}
