import { describe, expect, it } from 'vitest';
import { chatSanctionsQuerySchema } from '../src/chat-sanctions';
import { chatParticipantsQuerySchema } from '../src/chat-participants';
import { manualModerationActionRequestSchema } from '../src/manual-moderation';

describe('chat sanction and activity contracts', () => {
  it('defaults sanctions to active state without a journal range', () => {
    expect(chatSanctionsQuerySchema.parse({})).toEqual({
      status: 'active',
      action: 'all',
      limit: 30,
    });
    expect(chatSanctionsQuerySchema.safeParse({ limit: 51 }).success).toBe(false);
  });
  it('only allows expected sanction identity for release actions', () => {
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'UNBAN',
        expectedSanctionEventId: 's1',
      }).success,
    ).toBe(true);
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'BAN',
        expectedSanctionEventId: 's1',
      }).success,
    ).toBe(false);
    expect(
      manualModerationActionRequestSchema.safeParse({
        action: 'UNMUTE',
        expectedSanctionEventId: '',
      }).success,
    ).toBe(false);
  });
  it('accepts activity thresholds separately from violation range', () => {
    expect(
      chatParticipantsQuerySchema.parse({ range: '24h', activityFilter: '90d' }),
    ).toMatchObject({ range: '24h', activityFilter: '90d' });
    expect(chatParticipantsQuerySchema.safeParse({ activityFilter: 'offline' }).success).toBe(
      false,
    );
  });
});
