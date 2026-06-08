import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeApiBase } from '../src/lib/public-config';

test('keeps absolute and scheme-relative API bases intact', () => {
  assert.equal(
    normalizeApiBase('https://api-cdn.flex-craft.ru/api/v1'),
    'https://api-cdn.flex-craft.ru/api/v1',
  );
  assert.equal(normalizeApiBase('//major-maksimov.ru/api/v1'), '//major-maksimov.ru/api/v1');
});

test('normalizes relative API bases with a leading slash', () => {
  assert.equal(normalizeApiBase(undefined), '/api/v1');
  assert.equal(normalizeApiBase('api/v1'), '/api/v1');
  assert.equal(normalizeApiBase('/api/v1'), '/api/v1');
});
