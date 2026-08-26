import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isPublicLegalPathnameFromWindow,
  resolveRouterPathnameFromWindow,
} from '../src/lib/public-legal-route';

function assignWindow(url: string): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: new URL(url),
    },
  });
}

test.afterEach(() => {
  delete (globalThis as { window?: Window }).window;
});

test('detects public legal routes from direct browser paths without initData', () => {
  assignWindow('https://major-maksimov.ru/app/legal/agreement');

  assert.equal(resolveRouterPathnameFromWindow('browser'), '/legal/agreement');
  assert.equal(isPublicLegalPathnameFromWindow('browser'), true);
});

test('detects public legal routes from hash routes without initData', () => {
  assignWindow('https://major-maksimov.ru/app/#/legal/privacy');

  assert.equal(resolveRouterPathnameFromWindow('hash'), '/legal/privacy');
  assert.equal(isPublicLegalPathnameFromWindow('hash'), true);
});

test('detects public legal direct paths before hash-router migration runs', () => {
  assignWindow('https://major-maksimov.ru/app/legal/privacy');

  assert.equal(resolveRouterPathnameFromWindow('hash'), '/legal/privacy');
  assert.equal(isPublicLegalPathnameFromWindow('hash'), true);
});

test('keeps private app paths behind initData', () => {
  assignWindow('https://major-maksimov.ru/app/chat/chat-1/settings');

  assert.equal(isPublicLegalPathnameFromWindow('browser'), false);
});

test('keeps the Publik workspace behind initData', () => {
  assignWindow('https://major-maksimov.ru/app/publik');

  assert.equal(resolveRouterPathnameFromWindow('browser'), '/publik');
  assert.equal(isPublicLegalPathnameFromWindow('browser'), false);
});
