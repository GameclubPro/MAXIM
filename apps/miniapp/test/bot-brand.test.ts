import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLIK_BRAND, resolveModerationBotBrand } from '../src/lib/bot-brand';

test('authenticated bot links select the matching name and real avatar', () => {
  for (const [handles, name, image] of [
    [['id613070470872_9_bot', 'id613002203036_bot'], 'Майор Максимов', 'maximov.webp'],
    [['id613070470872_5_bot', 'id613002203036_4_bot'], 'Майор Максимова', 'maximova.webp'],
    [['id613070470872_6_bot', 'id613002203036_5_bot'], 'Рэкс', 'rex.webp'],
  ] as const) {
    for (const handle of handles) {
      const brand = resolveModerationBotBrand(`https://max.ru/${handle}`);
      assert.equal(brand.name, name);
      assert.equal(new URL(brand.avatarUrl!).pathname.split('/').at(-1), image);
    }
  }
  assert.equal(PUBLIK_BRAND.name, 'Публик');
  assert.ok(PUBLIK_BRAND.avatarUrl?.endsWith('/publik.webp'));
});

test('missing, unknown and untrusted identities do not borrow another bot identity', () => {
  for (const url of [
    null,
    'not a URL',
    'https://max.ru/unknown_bot',
    'https://max.ru/toString',
    'https://max.ru/__proto__',
    'https://example.com/id613070470872_5_bot',
    'http://max.ru/id613070470872_5_bot',
    'https://someone@max.ru/id613070470872_5_bot',
    'https://max.ru/id613070470872_5_bot?preview=1',
  ]) {
    assert.deepEqual(resolveModerationBotBrand(url), { name: 'Модерация', avatarUrl: null });
  }
});
