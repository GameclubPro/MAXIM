import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVirtualListRange } from '../src/lib/virtual-list';

test('resolves an empty virtual range', () => {
  assert.deepEqual(
    resolveVirtualListRange({
      itemCount: 0,
      scrollTop: 120,
      viewportHeight: 300,
      rowHeight: 90,
      overscan: 4,
    }),
    {
      startIndex: 0,
      endIndex: 0,
      totalHeight: 0,
    },
  );
});

test('keeps the first viewport inside the available items', () => {
  assert.deepEqual(
    resolveVirtualListRange({
      itemCount: 100,
      scrollTop: 0,
      viewportHeight: 270,
      rowHeight: 90,
      overscan: 2,
    }),
    {
      startIndex: 0,
      endIndex: 5,
      totalHeight: 9000,
    },
  );
});

test('adds overscan around a scrolled viewport', () => {
  assert.deepEqual(
    resolveVirtualListRange({
      itemCount: 100,
      scrollTop: 900,
      viewportHeight: 270,
      rowHeight: 90,
      overscan: 2,
    }),
    {
      startIndex: 8,
      endIndex: 15,
      totalHeight: 9000,
    },
  );
});

test('clamps the trailing viewport to the item count', () => {
  assert.deepEqual(
    resolveVirtualListRange({
      itemCount: 100,
      scrollTop: 8910,
      viewportHeight: 360,
      rowHeight: 90,
      overscan: 3,
    }),
    {
      startIndex: 96,
      endIndex: 100,
      totalHeight: 9000,
    },
  );
});
