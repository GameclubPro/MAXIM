import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ReactElement } from 'react';
import { SourcesBar } from '../src/components/vk-parsing/sources-bar';

function findElement(
  value: unknown,
  predicate: (element: ReactElement) => boolean,
): ReactElement | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findElement(child, predicate);
      if (found) {
        return found;
      }
    }
    return null;
  }

  if (!isValidElement(value)) {
    return null;
  }

  if (predicate(value)) {
    return value;
  }

  return findElement((value.props as { children?: unknown }).children, predicate);
}

test('VK source input accepts scheme-less community links', () => {
  const tree = SourcesBar({
    sourceUrl: 'vk.com/community',
    sources: [],
    selectedSourceId: null,
    openHintKey: null,
    isAdding: false,
    isRefreshing: false,
    isRemoving: false,
    onSourceUrlChange: () => undefined,
    onSubmitSource: () => undefined,
    onToggleHint: () => undefined,
    onRefresh: () => undefined,
    onSelectSource: () => undefined,
    onRemoveSource: () => undefined,
  });

  const input = findElement(tree, (element) => element.type === 'input');
  const props = input?.props as Record<string, unknown> | undefined;

  assert.equal(props?.type, 'text');
  assert.equal(props?.inputMode, 'url');
  assert.equal(props?.autoCapitalize, 'none');
  assert.equal(props?.autoCorrect, 'off');
  assert.equal(props?.spellCheck, false);
});
