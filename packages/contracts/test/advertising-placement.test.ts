import { describe, expect, it } from 'vitest';
import {
  advertisingChatIdSchema,
  advertisingSendInputSchema,
  advertisingSettingsInputSchema,
} from '../src/advertising-placement.js';

describe('advertising pilot inputs', () => {
  it('does not accept client-supplied actor, binding or delivery status', () => {
    const input = { enabled: true, revision: 0 };
    for (const extra of [
      { userId: '323459159' },
      { listingId: 'other' },
      { status: 'SENT' },
      { available: true },
    ])
      expect(advertisingSettingsInputSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(advertisingSettingsInputSchema.parse(input)).toEqual(input);
  });
  it('requires request identity and explicit previous-result acknowledgement', () => {
    const input = {
      requestId: '10000000-0000-4000-8000-000000000001',
      revision: 1,
      previousSendId: null,
    };
    expect(advertisingSendInputSchema.parse(input).acknowledgeUncertain).toBe(false);
    expect(advertisingSendInputSchema.safeParse({ ...input, requestId: '' }).success).toBe(false);
    expect(advertisingSendInputSchema.safeParse({ ...input, revision: 0 }).success).toBe(false);
  });
  it('rejects private-dialog IDs and URL injection', () => {
    for (const id of ['100', '-0', '--1', '-1&userId=777', '-1/other'])
      expect(advertisingChatIdSchema.safeParse(id).success).toBe(false);
    expect(advertisingChatIdSchema.parse('-100')).toBe('-100');
  });
});
