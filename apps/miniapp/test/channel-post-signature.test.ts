import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseChannelPostSignatureUrl,
  resolveChannelPostSignaturePreviewUrl,
} from '../src/lib/channel-post-signature';

test('channel post signature preview rejects unsafe custom URLs without using the fallback', () => {
  const resolved = resolveChannelPostSignaturePreviewUrl(
    'javascript:alert(1)',
    'https://max.ru/our-channel',
  );

  assert.equal(resolved.url, '');
  assert.match(resolved.error ?? '', /корректную ссылку/u);
});

test('channel post signature preview uses a safe channel fallback for an empty custom URL', () => {
  assert.deepEqual(resolveChannelPostSignaturePreviewUrl('', 'https://max.ru/our-channel'), {
    error: null,
    url: 'https://max.ru/our-channel',
  });
});

test('channel post signature preview preserves a validated external custom URL', () => {
  assert.deepEqual(parseChannelPostSignatureUrl(' https://example.com/contact?source=max '), {
    error: null,
    url: 'https://example.com/contact?source=max',
  });
});
