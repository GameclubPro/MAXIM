import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
} from '@maxim/contracts';
import { MAX_PREPARED_IMAGE_BYTES } from '../src/lib/broadcast-image';
import { resolveSuggestionDialogImageMaxBytes } from '../src/lib/dialog-attachments';

test('uses the full image budget for a single suggestion photo', () => {
  assert.equal(resolveSuggestionDialogImageMaxBytes(1, 0), MAX_PREPARED_IMAGE_BYTES);
});

test('splits the suggestion image budget across a ten-photo batch', () => {
  const maxBytes = resolveSuggestionDialogImageMaxBytes(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES, 0);

  assert.ok(maxBytes > 1_000_000);
  assert.ok(maxBytes < MAX_PREPARED_IMAGE_BYTES);
  assert.ok(
    Math.ceil((maxBytes * 4) / 3) * MAX_CHANNEL_DIALOG_SUGGEST_IMAGES <=
      MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  );
});
