import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeMiniappBootTraceText } from '../src/lib/boot-trace';
import {
  claimPublicationApiTraceSample,
  shouldEnablePublicationApiTrace,
} from '../src/lib/publication-api-trace';

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

test('boot trace text sanitizer redacts exact search parameter keys', () => {
  const sanitized = sanitizeMiniappBootTraceText(
    '/app/publications?q=first&query=second&search=third&searchMode=all',
    1_000,
  );

  assert.match(sanitized, /q=\[redacted\]/u);
  assert.match(sanitized, /query=\[redacted\]/u);
  assert.match(sanitized, /search=\[redacted\]/u);
  assert.match(sanitized, /searchMode=all/u);
  assert.equal(sanitized.includes('first'), false);
  assert.equal(sanitized.includes('second'), false);
  assert.equal(sanitized.includes('third'), false);
});

test('publication API trace samples are bounded by operation, outcome, and boot window', () => {
  const samples = new Set<string>();

  assert.equal(claimPublicationApiTraceSample('list', 'ok', 1_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('list', 'ok', 2_000, samples), false);
  assert.equal(claimPublicationApiTraceSample('list', 'error', 2_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('details', 'ok', 600_000, samples), true);
  assert.equal(claimPublicationApiTraceSample('action', 'ok', 600_001, samples), false);
});

test('publication API traces cover native Android and iOS without enabling ordinary browsers', () => {
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'android', false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0 MAX/1.2.3', null, false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'ios', false), true);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', 'web', false), false);
  assert.equal(shouldEnablePublicationApiTrace('Mozilla/5.0', null, true), true);
});
