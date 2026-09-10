import assert from 'node:assert/strict';
import test from 'node:test';
import { appendToast } from '../src/components/ui/toast-state';

test('ordinary notifications preserve their existing order', () => {
  assert.deepEqual(appendToast([{ id: 1 }], { id: 2 }), [{ id: 1 }, { id: 2 }]);
});

test('only feedback with the same replacement key is superseded', () => {
  const items = [{ id: 1, replaceKey: 'post-a' }, { id: 2, replaceKey: 'post-b' }, { id: 3 }];
  assert.deepEqual(appendToast(items, { id: 4, replaceKey: 'post-a' }), [
    items[1],
    items[2],
    { id: 4, replaceKey: 'post-a' },
  ]);
  assert.equal(items.length, 3);
});

test('an older timeout cannot remove a newer replacement', () => {
  const items = appendToast([{ id: 1, replaceKey: 'post' }], { id: 2, replaceKey: 'post' });
  assert.deepEqual(
    items.filter((item) => item.id !== 1),
    [{ id: 2, replaceKey: 'post' }],
  );
});
