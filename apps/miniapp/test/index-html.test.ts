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

test('dark theme is bootstrapped before the bridge and React to prevent a white first frame', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const bootstrapIndex = html.indexOf('const root = document.documentElement');
  const bridgeIndex = html.indexOf('https://st.max.ru/js/max-web-app.js');
  const appIndex = html.indexOf('/src/main.tsx');

  assert.match(html, /<meta\s+name="color-scheme"\s+content="light dark"\s*\/>/u);
  assert.match(html, /@media\s*\(prefers-color-scheme:\s*dark\)[\s\S]*?background:\s*#0d141b/u);
  assert.match(html, /normalizeTheme\(root\.dataset\.maxTheme\)\s*\?\?/u);
  assert.match(
    html,
    /normalizeTheme\(bridge\?\.colorScheme\s*\?\?\s*bridge\?\.color_scheme\s*\?\?\s*bridge\?\.theme\)/u,
  );
  assert.ok(bootstrapIndex >= 0);
  assert.ok(bootstrapIndex < bridgeIndex);
  assert.ok(bootstrapIndex < appIndex);
});
