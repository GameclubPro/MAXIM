import { ManagedEntityAccessRole, ManagedEntityAccessState } from '../prisma/prisma-client';
import type { Prisma } from '../prisma/prisma-client';

// FLAG: An equal-time denial must still beat a grant, while an exact denial replay must not
// rewrite updated_at and amplify PostgreSQL I/O.
export function buildMembershipDenialEdgeAdvanceWhere(params: {
  chatId: string;
  userIds: readonly string[];
  eventAt: Date;
  source: string;
}): Prisma.ManagedEntityAccessEdgeWhereInput {
  return {
    chatId: params.chatId,
    userId: { in: [...params.userIds] },
    OR: [
      { checkedAt: { lt: params.eventAt } },
      {
        checkedAt: params.eventAt,
        OR: [
          { state: { not: ManagedEntityAccessState.USER_DENIED } },
          { userRole: { not: ManagedEntityAccessRole.MEMBER } },
          { botRole: { not: ManagedEntityAccessRole.UNKNOWN } },
          { expiresAt: { not: null } },
          { deniedReason: null },
          { deniedReason: { not: params.source } },
          { source: { not: params.source } },
        ],
      },
    ],
  };
}
