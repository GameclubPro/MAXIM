import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:3015/app/');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))
  throw new Error('Local server required');
const browser = await chromium.launch();
try {
  for (const kind of ['moderation', 'activity']) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/events-test', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<html><body><div id="root"></div><script type="module">
      import RefreshRuntime from '/app/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
      await import('/app/test/fixtures/events-feed-harness.tsx');
      </script></body></html>`,
      }),
    );
    const result = (ids, nextCursor = null) => ({
      items: ids.map((id) => ({ id })),
      hasMore: !!nextCursor,
      nextCursor,
    });
    const render = (options = {}) =>
      page.evaluate((value) => window.eventTest.render(value), { chatId: 'a', kind, ...options });
    const pending = (n) =>
      page.waitForFunction((count) => window.eventTest.pending.length === count, n);
    const ids = () => page.evaluate(() => window.eventTest.current.items.map((item) => item.id));
    const resolve = async (index, data) => {
      await page.evaluate(({ index, data }) => window.eventTest.pending[index].resolve(data), {
        index,
        data,
      });
      await page.waitForFunction(
        () =>
          !window.eventTest.current.isReloading &&
          !window.eventTest.current.isLoadingMore &&
          !window.eventTest.current.isRefreshing,
      );
    };
    const fresh = async (options = {}) => {
      await page.goto(new URL('events-test', base).href);
      await page.waitForFunction(() => !!window.eventTest);
      await render(options);
      await pending(1);
    };

    await fresh();
    await render({ chatId: 'b' });
    await pending(2);
    assert.equal(await page.evaluate(() => window.eventTest.pending[0].signal.aborted), true);
    await resolve(1, result(['b']));
    await resolve(0, result(['a']));
    assert.deepEqual(await ids(), ['b']);
    assert.equal(
      await page.evaluate(() =>
        window.eventTest.history.some((s) => s.chatId === 'b' && s.ids.includes('a')),
      ),
      false,
    );

    await fresh();
    await resolve(0, result(['unfiltered']));
    if (kind === 'activity') {
      await page.evaluate(() => window.eventTest.current.setFilter('joined'));
    } else {
      await render({ filter: 'BAN' });
    }
    await pending(2);
    assert.deepEqual(await ids(), []);
    await resolve(1, result(['filtered']));

    await fresh({ initialPage: result(['cached']) });
    await resolve(0, result(['fresh'], 'next'));
    await render({ initialPage: result(['late-dashboard']) });
    assert.deepEqual(await ids(), ['fresh']);
    await page.evaluate(() => {
      void window.eventTest.current.loadMore();
      void window.eventTest.current.loadMore();
    });
    await pending(2);
    await resolve(1, result(['fresh', 'older'], 'older-next'));
    assert.deepEqual(await ids(), ['fresh', 'older']);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 2);
    await page.evaluate(() => void window.eventTest.current.loadMore());
    await pending(3);
    await page.evaluate(() => window.eventTest.pending[2].reject(new Error('temporary')));
    await page.waitForFunction(() => !!window.eventTest.current.error);
    await page.evaluate(() => void window.eventTest.current.retryFailed());
    await pending(4);
    assert.equal(await page.evaluate(() => window.eventTest.pending[3].query.cursor), 'older-next');
    await resolve(3, result(['oldest'], 'older-next'));
    assert.ok(await page.evaluate(() => window.eventTest.current.error));
    assert.deepEqual(await ids(), ['fresh', 'older']);
    await page.evaluate(() => void window.eventTest.current.retry());
    await pending(5);
    assert.equal(await page.evaluate(() => window.eventTest.pending[4].query.cursor), undefined);
    await resolve(4, result(['latest']));

    await fresh();
    await page.evaluate(() => {
      const error = Object.assign(new Error('access denied'), {
        name: 'ApiRequestError',
        status: 403,
      });
      window.eventTest.pending[0].reject(error);
    });
    await page.waitForFunction(() => !!window.eventTest.current.error);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 1);
    await page.evaluate(() => void window.eventTest.current.retry());
    await pending(2);
    await resolve(1, result(['authorized-again']));

    await fresh();
    await resolve(0, result(['first']));
    await page.clock.install();
    await page.clock.runFor(10_001);
    await pending(2);
    await page.clock.runFor(30_000);
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 2);
    await resolve(1, result(['second']));
    await page.evaluate(() =>
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }),
    );
    await page.clock.runFor(30_000);
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pending(3);
    await page.evaluate(() => window.eventTest.pending[2].reject(new Error('temporary')));
    await page.waitForFunction(() => !!window.eventTest.current.error);
    assert.deepEqual(await ids(), ['second']);
    await page.clock.runFor(10_001);
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 3);
    await page.clock.runFor(10_001);
    await pending(4);
    await resolve(3, result(['recovered']));
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }),
    );
    await page.clock.runFor(30_000);
    assert.equal(await page.evaluate(() => window.eventTest.pending.length), 4);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await pending(5);
    await page.evaluate(() => window.eventTest.unmount());
    assert.equal(await page.evaluate(() => window.eventTest.pending[4].signal.aborted), true);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${kind}: scope isolation, snapshot races, refresh, pagination, deduplication, cursor guard, backoff, visibility, offline recovery, unmount`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
