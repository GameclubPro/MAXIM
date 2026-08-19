import type { ManagedEntityType } from '@maxim/contracts';
import type { ManagedPollListScope } from '@maxim/contracts/poll';

export const managedPollQueryKeys = {
  list: (
    entityType: ManagedEntityType,
    entityId: string | null | undefined,
    scope: ManagedPollListScope,
  ) => ['managed-polls', entityType, entityId, scope] as const,
  voters: (
    entityType: ManagedEntityType,
    entityId: string | null | undefined,
    pollId: string | null | undefined,
  ) => ['managed-poll-voters', entityType, entityId, pollId] as const,
};
