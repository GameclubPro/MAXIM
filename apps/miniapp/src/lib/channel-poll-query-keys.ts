export const channelPollQueryKeys = {
  list: (channelId: string | null | undefined) => ['channel-managed-polls', channelId] as const,
  details: (channelId: string | null | undefined, pollId: string | null | undefined) =>
    ['channel-managed-poll-details', channelId, pollId] as const,
  voters: (channelId: string | null | undefined, pollId: string | null | undefined) =>
    ['channel-managed-poll-voters', channelId, pollId] as const,
};
