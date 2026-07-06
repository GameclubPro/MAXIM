import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('MAX bridge script is loaded without blocking public legal routes', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const match = html.match(/<script[^>]+src="https:\/\/st\.max\.ru\/js\/max-web-app\.js"[^>]*>/u);

  assert.ok(match);
  assert.match(match[0], /\basync\b/u);
});
