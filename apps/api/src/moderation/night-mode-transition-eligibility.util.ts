import {
  membershipExplicitlyLacksAccess,
  normalizeMembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import { isMajorManagedEntityActivationRequired } from '../max/managed-entity-activation.util';
import { hasExecutionCapability } from '../max/max-execution-route-proof';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';

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
  botAccessSource?: string | null;
  permissionsSnapshot?: unknown;
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
  if (membershipExplicitlyLacksAccess(membership.permissionsSnapshot)) {
    return false;
  }
  // FLAG: Scheduling cannot repeatedly retry a capability that the final executor requires
  // an administrator to reactivate. Unknown legacy evidence remains refreshable; known
  // baseline/send denials and retained ceilings remain denied regardless of snapshot age.
  if (isMajorManagedEntityActivationRequired(membership, ChatEntityType.CHAT)) return false;
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  if (
    (snapshot?.activationCapabilityCeiling &&
      !snapshot.activationCapabilityCeiling.includes('send_message')) ||
    (snapshot?.permissionsKnown === true &&
      !hasExecutionCapability(
        { permissionsSnapshot: membership.permissionsSnapshot },
        ChatEntityType.CHAT,
        'send_message',
      ))
  )
    return false;

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
