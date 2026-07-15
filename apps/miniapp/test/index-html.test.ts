import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('MAX bridge script is loaded without blocking public legal routes', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script[^>]+src="https:\/\/st\.max\.ru\/js\/max-web-app\.js"[^>]*>/u);

  assert.ok(match);
  assert.match(match[0], /\basync\b/u);
});

test('viewport keeps browser zoom available', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(html, /maximum-scale\s*=/iu);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no/iu);
});

test('initial browser chrome color matches the light theme page surface', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  assert.match(html, /<meta\s+name="theme-color"\s+content="#f3f6f8"\s*\/>/u);
});
