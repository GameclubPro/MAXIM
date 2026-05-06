import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createChannelDialogMessageRequestSchema,
  MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64,
  MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH,
  MAX_CHANNEL_DIALOG_SUGGEST_IMAGES,
} from '@maxim/contracts';

const TINY_IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

test('keeps suggestion images out of mirrored attachments in the request body', () => {
  const parsed = createChannelDialogMessageRequestSchema.parse({
    token: 'suggest-token-123456',
    text: 'Подпись',
    textFormat: 'markdown',
    images: [
      {
        base64: TINY_IMAGE_BASE64,
        mimeType: 'image/png',
        fileName: 'suggestion.png',
      },
    ],
  });

  assert.equal(parsed.textFormat, 'markdown');
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.attachments.length, 0);
});

test('accepts ten suggestion images', () => {
  const parsed = createChannelDialogMessageRequestSchema.parse({
    token: 'suggest-token-123456',
    text: '',
    images: Array.from({ length: MAX_CHANNEL_DIALOG_SUGGEST_IMAGES }, (_, index) => ({
      base64: TINY_IMAGE_BASE64,
      mimeType: 'image/png',
      fileName: `suggestion-${index + 1}.png`,
    })),
  });

  assert.equal(MAX_CHANNEL_DIALOG_SUGGEST_IMAGES, 10);
  assert.equal(parsed.images.length, 10);
});

test('accepts a ten-photo suggestion payload above the old 5 MB aggregate limit', () => {
  const imageBase64 = 'a'.repeat(1_200_000);
  const parsed = createChannelDialogMessageRequestSchema.parse({
    token: 'suggest-token-123456',
    text: '',
    images: Array.from({ length: MAX_CHANNEL_DIALOG_SUGGEST_IMAGES }, (_, index) => ({
      base64: imageBase64,
      mimeType: 'image/jpeg',
      fileName: `iphone-${index + 1}.jpg`,
    })),
  });

  assert.equal(MAX_CHANNEL_DIALOG_IMAGE_BASE64_LENGTH, 8_000_000);
  assert.equal(MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64, 24_000_000);
  assert.equal(parsed.images.length, MAX_CHANNEL_DIALOG_SUGGEST_IMAGES);
});
