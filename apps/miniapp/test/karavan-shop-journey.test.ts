import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sellerApplicationUrl,
  shopNextAction,
  uniqueShopItems,
} from '../src/pages/settings/karavan-shop/shop-journey';

const id = 'a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
test('seller links retain the exact shop and use the existing separate seller launch', () => {
  const url = new URL(sellerApplicationUrl('https://max.ru/seller_bot?startapp=old#legacy', id)!);
  assert.equal(url.origin, 'https://max.ru');
  assert.equal(url.pathname, '/seller_bot');
  assert.deepEqual([...url.searchParams], [['startapp', `placement_${id}`]]);
  assert.equal(url.hash, '');
});
test('seller links fail closed for invalid bot origins, credentials, paths and shop ids', () => {
  for (const url of [
    undefined,
    '',
    'javascript:alert(1)',
    'http://max.ru/seller_bot',
    'https://max.ru.evil.test/seller_bot',
    'https://user@max.ru/seller_bot',
    'https://max.ru/seller_bot/nested',
    'https://max.ru:444/seller_bot',
  ])
    assert.equal(sellerApplicationUrl(url, id), null, url);
  for (const value of ['', `${id}__i_injected`, 'not-a-shop', `placement_${id}`])
    assert.equal(sellerApplicationUrl('https://max.ru/seller_bot', value), null);
});
const closed = {
  status: 'draft',
  listings: 0,
  pendingApplications: 0,
  canManage: true,
  canReview: true,
} as const;
test('an empty closed shop leads to its first seller, while pending applications lead to review', () => {
  assert.equal(shopNextAction(closed), 'invite');
  assert.equal(shopNextAction({ ...closed, pendingApplications: 2 }), 'review');
});
test('only verified ready storefronts make public opening the next action', () => {
  assert.equal(shopNextAction({ ...closed, listings: 2 }), 'sellers');
  assert.equal(shopNextAction({ ...closed, listings: 2, readyListings: 0 }), 'sellers');
  assert.equal(shopNextAction({ ...closed, listings: 2, readyListings: 1 }), 'open');
  assert.equal(
    shopNextAction({ ...closed, status: 'paused', listings: 2, readyListings: 1 }),
    'open',
  );
});
test('an open shop keeps public view primary and offers review only when needed', () => {
  assert.equal(shopNextAction({ ...closed, status: 'active', listings: 2 }), null);
  assert.equal(
    shopNextAction({ ...closed, status: 'active', listings: 2, pendingApplications: 1 }),
    'review',
  );
});
test('next actions respect review and management permissions and archive status', () => {
  assert.equal(shopNextAction({ ...closed, canManage: false }), null);
  assert.equal(shopNextAction({ ...closed, canManage: false, pendingApplications: 1 }), 'review');
  assert.equal(
    shopNextAction({ ...closed, canManage: false, canReview: false, pendingApplications: 1 }),
    null,
  );
  assert.equal(shopNextAction({ ...closed, status: 'archived', pendingApplications: 1 }), null);
});
test('cursor pages retain prior order without duplicate or stale storefront versions', () => {
  assert.deepEqual(
    uniqueShopItems([
      [
        { id: 'first', revision: 1 },
        { id: 'second', revision: 1 },
      ],
      [
        { id: 'second', revision: 2 },
        { id: 'third', revision: 1 },
      ],
    ]),
    [
      { id: 'first', revision: 1 },
      { id: 'second', revision: 2 },
      { id: 'third', revision: 1 },
    ],
  );
});
