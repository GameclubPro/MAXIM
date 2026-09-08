import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3000/app/';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/participants-test', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: `<html><body><div id="root"></div><script type="module">
    import RefreshRuntime from '/app/@react-refresh';
    RefreshRuntime.injectIntoGlobalHook(window);
    window.$RefreshReg$ = () => {};
    window.$RefreshSig$ = () => (type) => type;
    window.__vite_plugin_react_preamble_installed__ = true;
    await import('/app/test/fixtures/participants-feed-harness.tsx');
  </script></body></html>`,
  }),
);

const item = (userId, violationCount = 0) => ({
  userId,
  userDisplayName: userId,
  violationCount,
  role: 'member',
  isBot: false,
  username: null,
  avatarUrl: null,
  profileUrl: null,
  profileHandoffUrl: null,
  immunity: null,
});
const result = (items, nextCursor = null) => ({
  items,
  totalCount: 500,
  hasMore: !!nextCursor,
  nextCursor,
});
const render = async (options) => {
  await page.evaluate((value) => window.participantTest.render(value), options);
};
const pending = (count) =>
  page.waitForFunction((n) => window.participantTest.pending.length === n, count);
const resolve = async (index, data) => {
  await page.evaluate(({ index, data }) => window.participantTest.pending[index].resolve(data), {
    index,
    data,
  });
  await page.waitForFunction(
    () =>
      !window.participantTest.current.isReloading && !window.participantTest.current.isLoadingMore,
  );
};
const state = () =>
  page.evaluate(() => {
    const { items, firstPage, error, errorKind, hasMore } = window.participantTest.current;
    return { items, firstPage, error, errorKind, hasMore };
  });
const fresh = async (options = { chatId: 'a' }) => {
  await page.goto(new URL('participants-test', base).href);
  await page.waitForFunction(() => !!window.participantTest);
  await render(options);
};

try {
  await fresh();
  await pending(1);
  await render({ chatId: 'b' });
  await pending(2);
  assert.equal(await page.evaluate(() => window.participantTest.pending[0].signal.aborted), true);
  await resolve(1, result([item('b-member')]));
  await resolve(0, result([item('a-member')]));
  assert.deepEqual(
    (await state()).items.map((row) => row.userId),
    ['b-member'],
  );
  assert.equal(
    await page.evaluate(() =>
      window.participantTest.history.some(
        (entry) => entry.chatId === 'b' && entry.ids.includes('a-member'),
      ),
    ),
    false,
  );
  console.log('PASS: chat switch aborts requests and rejects late responses');

  await fresh();
  await pending(1);
  await resolve(0, result([item('a')], 'page-2'));
  await page.evaluate(() => {
    void window.participantTest.current.loadMore();
    void window.participantTest.current.loadMore();
  });
  await pending(2);
  await resolve(1, result([item('a', 4), item('b')], 'page-3'));
  const merged = await state();
  assert.deepEqual(
    merged.items.map((row) => [row.userId, row.violationCount]),
    [
      ['a', 4],
      ['b', 0],
    ],
  );
  assert.equal(merged.firstPage.nextCursor, 'page-2');
  assert.equal(merged.firstPage.items.length, 1);
  console.log('PASS: duplicate load is locked and first-page snapshot retains its cursor');

  await page.evaluate(() => void window.participantTest.current.loadMore());
  await pending(3);
  await page.evaluate(() =>
    window.participantTest.pending[2].reject(new Error('Temporary failure')),
  );
  await page.waitForFunction(() => !!window.participantTest.current.error);
  assert.equal((await state()).errorKind, 'more');
  await page.evaluate(() => void window.participantTest.current.retryFailed());
  await pending(4);
  assert.equal(await page.evaluate(() => window.participantTest.pending[3].query.cursor), 'page-3');
  await resolve(3, result([item('c')]));
  assert.equal((await state()).items.length, 3);
  console.log('PASS: failed continuation retries its cursor without dropping previous rows');

  await fresh({ chatId: 'a', initialPage: result([item('cached')], 'cached-next') });
  await page.waitForFunction(() => window.participantTest.current?.items.length === 1);
  assert.equal(await page.evaluate(() => window.participantTest.pending.length), 0);
  await page.evaluate(() => void window.participantTest.current.retry());
  await pending(1);
  await resolve(0, result([item('fresh')]));
  assert.equal((await state()).items[0].userId, 'fresh');
  console.log('PASS: explicit refresh bypasses initial snapshot');

  await fresh();
  await pending(1);
  await resolve(0, result([item('old')], 'next'));
  await render({ chatId: 'a', search: 'новый' });
  await pending(2);
  assert.equal((await state()).items.length, 0);
  assert.equal(await page.evaluate(() => window.participantTest.pending[1].query.limit), 24);
  await render({ chatId: 'a', search: 'другой' });
  await pending(3);
  await resolve(2, result([item('latest')]));
  await resolve(1, result([item('stale')]));
  assert.equal((await state()).items[0].userId, 'latest');
  console.log('PASS: search scope clears old rows and ignores superseded results');

  await fresh();
  await pending(1);
  await resolve(0, result([item('first')], 'repeated'));
  await page.evaluate(() => void window.participantTest.current.loadMore());
  await pending(2);
  await resolve(1, result([item('second')], 'repeated'));
  assert.ok((await state()).error);
  assert.equal((await state()).items.length, 1);
  console.log('PASS: repeated cursor stops pagination without corrupting the list');

  await fresh({ chatId: 'a', roster: true });
  await pending(1);
  for (let index = 0; index < 4; index += 1) {
    await page.evaluate(({ index, data }) => window.participantTest.pending[index].resolve(data), {
      index,
      data: result([], `cursor-${index}`),
    });
    if (index < 3) await pending(index + 2);
  }
  await page.waitForFunction(() => !window.participantTest.current.isLoadingMore);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.participantTest.pending.length), 4);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await pending(5);
  await resolve(4, result([]));
  console.log('PASS: empty-page scanning is bounded and can be resumed manually');

  await fresh({ chatId: 'a', roster: true });
  await pending(1);
  await page.evaluate(
    (data) => window.participantTest.pending[0].resolve(data),
    result([], 'next'),
  );
  await pending(2);
  await page.evaluate(() =>
    window.participantTest.pending[1].reject(new Error('Не удалось загрузить')),
  );
  await page.getByRole('alert').waitFor();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.participantTest.pending.length), 2);
  await page.getByRole('button', { name: 'Повторить' }).click();
  await pending(3);
  assert.equal(await page.evaluate(() => window.participantTest.pending[2].query.cursor), 'next');
  await resolve(2, result([item('recovered')]));
  console.log('PASS: roster stops automatic retries after an error and resumes on request');

  await fresh();
  await pending(1);
  await resolve(0, result([item('first')], 'next'));
  await page.evaluate(() => void window.participantTest.current.loadMore());
  await pending(2);
  await page.evaluate(() => window.participantTest.unmount());
  assert.equal(await page.evaluate(() => window.participantTest.pending[1].signal.aborted), true);
  assert.deepEqual(errors, []);
  console.log('PASS: unmount aborts an in-flight continuation; no browser errors');
} finally {
  await browser.close();
}
