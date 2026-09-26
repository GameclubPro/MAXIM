import { describe, expect, it } from 'vitest';
import { chatParticipantDetailsSchema } from '../src/participant-details.js';
import { chatParticipantItemSchema } from '../src/chat-participants.js';

describe('participant details', () => {
  it('represents a former or unknown participant without inventing a current role', () => {
    for (const membershipStatus of ['left', 'unknown']) {
      const details = chatParticipantDetailsSchema.parse({
        userId: '42',
        userDisplayName: 'Alex',
        role: null,
        membershipStatus,
        canManage: false,
      });
      expect(details.role).toBeNull();
      expect(details.canManage).toBe(false);
    }
  });
  it('does not relax the existing roster contract', () => {
    expect(
      chatParticipantItemSchema.safeParse({ userId: '42', userDisplayName: 'Alex', role: null })
        .success,
    ).toBe(false);
  });
  it('requires an explicit membership and action capability', () => {
    expect(
      chatParticipantDetailsSchema.safeParse({
        userId: '42',
        userDisplayName: 'Alex',
        role: 'member',
      }).success,
    ).toBe(false);
  });
});
