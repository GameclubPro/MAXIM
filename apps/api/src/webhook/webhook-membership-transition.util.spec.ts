import { ManagedEntityAccessRole, ManagedEntityAccessState } from '../prisma/prisma-client';
import { buildMembershipDenialEdgeAdvanceWhere } from './webhook-membership-transition.util';

describe('buildMembershipDenialEdgeAdvanceWhere', () => {
  it('advances older epochs and only repairs mismatched denial fields at an equal epoch', () => {
    const eventAt = new Date('2026-08-31T12:00:00.123Z');

    expect(
      buildMembershipDenialEdgeAdvanceWhere({
        chatId: 'chat-1',
        userIds: ['user-1', 'iduser-1'],
        eventAt,
        source: 'webhook_user_removed',
      }),
    ).toEqual({
      chatId: 'chat-1',
      userId: { in: ['user-1', 'iduser-1'] },
      OR: [
        { checkedAt: { lt: eventAt } },
        {
          checkedAt: eventAt,
          OR: [
            { state: { not: ManagedEntityAccessState.USER_DENIED } },
            { userRole: { not: ManagedEntityAccessRole.MEMBER } },
            { botRole: { not: ManagedEntityAccessRole.UNKNOWN } },
            { expiresAt: { not: null } },
            { deniedReason: null },
            { deniedReason: { not: 'webhook_user_removed' } },
            { source: { not: 'webhook_user_removed' } },
          ],
        },
      ],
    });
  });

  it('keeps the event-specific denial source in both equal-epoch mismatch checks', () => {
    const where = buildMembershipDenialEdgeAdvanceWhere({
      chatId: 'chat-1',
      userIds: ['user-1'],
      eventAt: new Date('2026-08-31T12:00:00.123Z'),
      source: 'webhook_user_added',
    });

    expect(where.OR?.[1]).toEqual(
      expect.objectContaining({
        OR: expect.arrayContaining([
          { deniedReason: { not: 'webhook_user_added' } },
          { source: { not: 'webhook_user_added' } },
        ]),
      }),
    );
  });
});
