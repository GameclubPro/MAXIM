import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the sibling marketplace has a distinct prefix-stripping upstream and complete headers', async () => {
  const source = await readFile(
    new URL('../nginx/major-maksimov.ru.conf', import.meta.url),
    'utf8',
  );
  const location = source.match(/location \^~ \/market\/ \{([\s\S]*?)\n {2}\}/)?.[1];
  assert.ok(location);
  assert.match(location, /proxy_pass http:\/\/127\.0\.0\.1:4311\/;/);
  assert.match(location, /client_max_body_size 64k;/);
  for (const header of [
    'Strict-Transport-Security',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'X-Robots-Tag',
  ])
    assert.ok(location.includes(`add_header ${header} `));
  assert.doesNotMatch(location, /X-Frame-Options|3001|3002|3003/);
  assert.match(source, /location \/app\/ \{\s+proxy_pass http:\/\/127\.0\.0\.1:3003;/);
});
