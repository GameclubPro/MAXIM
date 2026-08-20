import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';

export const NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES = [
  ChatBotAccessState.UNKNOWN,
  ChatBotAccessState.STALE,
  ChatBotAccessState.CONFIRMED_ADMIN,
  ChatBotAccessState.CONFIRMED_OWNER,
] as const;

export type NightModeTransitionMembershipCandidate = {
  botId?: string | null;
  status?: ChatBotMembershipStatus | string | null;
  botAccessState?: ChatBotAccessState | string | null;
};

export function isNightModeTransitionMembershipCandidate(
  membership: NightModeTransitionMembershipCandidate | null | undefined,
  options: { isActionableBotId?: (botId: string) => boolean } = {},
): boolean {
  if (membership?.status !== ChatBotMembershipStatus.ACTIVE) {
    return false;
  }

  const botId = normalizeBotId(membership.botId);
  if (!botId || (options.isActionableBotId && !options.isActionableBotId(botId))) {
    return false;
  }

  const accessState = membership.botAccessState;
  return (
    accessState === null ||
    accessState === undefined ||
    NIGHT_MODE_TRANSITION_REFRESHABLE_ACCESS_STATES.some((state) => state === accessState)
  );
}

export function hasNightModeTransitionMembershipCandidate(
  memberships: readonly NightModeTransitionMembershipCandidate[],
  options: { isActionableBotId?: (botId: string) => boolean } = {},
): boolean {
  return memberships.some((membership) =>
    isNightModeTransitionMembershipCandidate(membership, options),
  );
}

function normalizeBotId(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}
