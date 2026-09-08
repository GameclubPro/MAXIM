import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import {
  Children,
  isValidElement,
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type SetStateAction,
} from 'react';
import {
  createEmptyPublicationDraft,
  type PublicationDraft,
} from '../src/features/publications/publication-model';

const cssHook = registerHooks({
  load(url, context, nextLoad) {
    return url.endsWith('.css')
      ? { format: 'module', source: '', shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { PublicationContentEditorSection } =
  await import('../src/features/publications/publication-content-editor-section');
cssHook.deregister();

function findTitleInput(node: ReactNode): InputHTMLAttributes<HTMLInputElement> | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<InputHTMLAttributes<HTMLInputElement>>(child)) {
      continue;
    }
    if (child.type === 'input' && child.props.className === 'publication-title-input') {
      return child.props;
    }
    const input = findTitleInput(child.props.children);
    if (input) {
      return input;
    }
  }
  return null;
}

function renderTitleInput(setDraft: (action: SetStateAction<PublicationDraft>) => void) {
  const noop = () => undefined;
  return findTitleInput(
    PublicationContentEditorSection({
      sectionRef: { current: null },
      draft: { ...createEmptyPublicationDraft(), timingMode: 'schedule' },
      setDraft,
      importOmissions: [],
      importing: false,
      importedAssetPreviews: [],
      customButtons: [],
      systemButtons: [],
      previewTargets: [],
      previewTargetKey: null,
      customButtonCount: 0,
      hasButtonErrors: false,
      showButtonsLabel: false,
      isBusy: false,
      operationBusy: false,
      imagesNeedReselection: false,
      missingImageCount: 0,
      retainedVideo: false,
      videoPreparing: false,
      videoNeedsReselection: false,
      fieldError: '',
      onDiscardMissingImages: noop,
      onResolveMissingImages: noop,
      onPreviewTargetChange: noop,
      onOpenButtons: noop,
      onVideoFile: async () => undefined,
      onImagePreparationChange: noop,
      onFieldError: noop,
      onInfo: noop,
    }),
  );
}

test('title edits survive deferred and replayed state updates after the input event ends', () => {
  const updates: SetStateAction<PublicationDraft>[] = [];
  const input = renderTitleInput((update) => updates.push(update));
  assert.ok(input?.onChange);
  const titles = ['K', 'KU', 'BUY SELL', '', 'Replacement title'];

  for (const title of titles) {
    const target = { value: title };
    const event = { currentTarget: target };
    input.onChange(event as ChangeEvent<HTMLInputElement>);
    // React clears currentTarget after dispatch; the DOM value can change before a replay.
    Object.assign(event, { currentTarget: null });
    target.value = 'Later DOM value';
  }

  assert.equal(updates.length, titles.length);
  let draft: PublicationDraft = {
    ...createEmptyPublicationDraft(),
    timingMode: 'schedule',
    text: 'Post body updated before the queued title edits',
    textFormat: 'html',
  };
  for (const [index, update] of updates.entries()) {
    assert.equal(typeof update, 'function');
    if (typeof update !== 'function') {
      assert.fail('Title edits must merge with the latest draft');
    }
    const expected = { ...draft, title: titles[index] };
    assert.deepEqual(update(draft), expected);
    assert.deepEqual(update(draft), expected);
    draft = expected;
  }
});
