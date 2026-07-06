import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeMiniappBootTraceText } from '../src/lib/boot-trace';

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

test('boot trace text sanitizer redacts startapp and channel dialog payload previews', () => {
  const dialogToken = 'dialog-token-secret-123456';
  const encodedPayload = encodeBase64Url({
    v: 1,
    k: 'chat-dialog',
    c: '-100',
    m: 'comments',
    t: dialogToken,
  });
  const startParam = `cd-${encodedPayload}`;

  const sanitized = sanitizeMiniappBootTraceText(
    [
      `/app/?startapp=${startParam}&screen=dialog`,
      `start_param=${startParam}`,
      `preview ${startParam}`,
      JSON.stringify({
        v: 1,
        k: 'chat-dialog',
        c: '-100',
        m: 'comments',
        t: dialogToken,
      }),
    ].join(' | '),
    1_000,
  );

  assert.equal(sanitized.includes(dialogToken), false);
  assert.equal(sanitized.includes(encodedPayload), false);
  assert.match(sanitized, /startapp=\[redacted\]/u);
  assert.match(sanitized, /start_param=\[redacted\]/u);
  assert.match(sanitized, /preview cd-\[redacted\]/u);
  assert.match(sanitized, /"t":"\[redacted\]"/u);
});
