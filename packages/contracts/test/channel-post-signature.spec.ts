import { describe, expect, it } from 'vitest';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH,
  channelPostSignatureSettingsSchema,
  updateChannelPostSignatureRequestSchema,
} from '../src/channel-post-signature.js';

describe('channel post signature contracts', () => {
  it('keeps a fail-safe disabled default with stable link text', () => {
    expect(channelPostSignatureSettingsSchema.parse({})).toEqual({
      enabled: false,
      text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
    });
  });

  it('trims saved text and rejects empty or oversized labels', () => {
    expect(updateChannelPostSignatureRequestSchema.parse({ text: '  Читать канал  ' })).toEqual({
      text: 'Читать канал',
    });
    expect(updateChannelPostSignatureRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(
      updateChannelPostSignatureRequestSchema.safeParse({
        text: 'a'.repeat(CHANNEL_POST_SIGNATURE_TEXT_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('requires at least one field in a partial update', () => {
    expect(updateChannelPostSignatureRequestSchema.safeParse({}).success).toBe(false);
    expect(updateChannelPostSignatureRequestSchema.parse({ enabled: true })).toEqual({
      enabled: true,
    });
  });
});
