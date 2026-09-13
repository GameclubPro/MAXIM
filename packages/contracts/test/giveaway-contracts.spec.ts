import { describe, expect, it } from 'vitest';
import { managedGiveawayPublicSchema } from '@maxim/contracts/giveaway';

const sourceAvatarSchema = managedGiveawayPublicSchema.pick({ sourceAvatarUrl: true });

describe('public giveaway source avatar', () => {
  it('preserves the source avatar URL', () => {
    const sourceAvatarUrl = 'https://cdn.example.com/channel-avatar.jpg';
    expect(sourceAvatarSchema.parse({ sourceAvatarUrl })).toEqual({ sourceAvatarUrl });
  });

  it('supports sources without a photo and older API responses', () => {
    expect(sourceAvatarSchema.parse({ sourceAvatarUrl: null })).toEqual({ sourceAvatarUrl: null });
    expect(sourceAvatarSchema.parse({})).toEqual({});
  });

  it('rejects malformed avatar URLs', () => {
    expect(sourceAvatarSchema.safeParse({ sourceAvatarUrl: 'not-a-url' }).success).toBe(false);
  });
});
