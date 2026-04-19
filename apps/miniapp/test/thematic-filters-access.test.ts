import assert from 'node:assert/strict';
import test from 'node:test';
import { canUserAccessThematicFilters } from '../src/lib/thematic-filters-access';

test('allows both thematic filter admins', () => {
  assert.equal(canUserAccessThematicFilters('98315271'), true);
  assert.equal(canUserAccessThematicFilters('16316155'), true);
});

test('rejects unknown or empty thematic filter admins', () => {
  assert.equal(canUserAccessThematicFilters(''), false);
  assert.equal(canUserAccessThematicFilters('00000000'), false);
  assert.equal(canUserAccessThematicFilters(null), false);
});
