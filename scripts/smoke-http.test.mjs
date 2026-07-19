import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { findStaticAssets, smokeJsonOk, smokeStaticSite } from './smoke-http.mjs';

test('resolves script and stylesheet assets against the final page URL', () => {
  assert.deepEqual(
    findStaticAssets(
      '<link rel="stylesheet" href="./assets/app.css"><script src="/app/assets/app.js"></script>',
      'https://example.test/app/',
    ),
    {
      js: ['https://example.test/app/assets/app.js'],
      css: ['https://example.test/app/assets/app.css'],
    },
  );
});

test('checks JSON health and fetches static assets', async (context) => {
  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    } else if (request.url === '/app/') {
      response.end(
        '<div id="root"></div><link href="assets/app.css" rel="stylesheet"><script src="assets/app.js"></script>',
      );
    } else if (request.url?.endsWith('.css')) {
      response.end('body {}');
    } else if (request.url?.endsWith('.js')) {
      response.end('void 0;');
    } else {
      response.statusCode = 404;
      response.end('missing');
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => server.close());
  const address = server.address();
  assert.equal(typeof address, 'object');
  const base = `http://127.0.0.1:${address.port}`;
  await smokeJsonOk(`${base}/health`);
  const assets = await smokeStaticSite(`${base}/app/`);
  assert.equal(assets.js.length, 1);
  assert.equal(assets.css.length, 1);
});
