import type { ManagedEntityType } from '@maxim/contracts';

export const managedPollQueryKeys = {
  list: (entityType: ManagedEntityType, entityId: string | null | undefined) =>
    ['managed-polls', entityType, entityId] as const,
  details: (
    entityType: ManagedEntityType,
    entityId: string | null | undefined,
    pollId: string | null | undefined,
  ) => ['managed-poll-details', entityType, entityId, pollId] as const,
  voters: (
    entityType: ManagedEntityType,
    entityId: string | null | undefined,
    pollId: string | null | undefined,
  ) => ['managed-poll-voters', entityType, entityId, pollId] as const,
};
