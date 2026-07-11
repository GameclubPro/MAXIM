import { createHash } from 'node:crypto';
import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import type { MaxBotLifecycleState } from './max-bot-config.util';
import { membershipExplicitlyLacksAccess } from './max-bot-access-policy.util';
import { canExecuteActionsForBotState } from './max-bot-state.util';

export type MaxBotOwnershipCandidate = {
  botId: string;
  membershipStatus: ChatBotMembershipStatus;
  lifecycleState: MaxBotLifecycleState;
  capabilityEligible: boolean;
  botAccessState?: ChatBotAccessState | null;
  permissionsSnapshot?: unknown;
  ownershipWeight?: number | null;
};

export type StableMaxBotOwnershipAssignmentOptions = {
  currentOwnerBotId?: string | null;
  rebalance?: boolean;
};

const MAX_HASH_INTEGER = 2 ** 53;

export function resolveWeightedRendezvousOwnerBotId(
  entityKey: string,
  candidates: readonly MaxBotOwnershipCandidate[],
): string | null {
  const normalizedEntityKey = entityKey.trim();
  if (!normalizedEntityKey) {
    return null;
  }

  const eligibleCandidates = candidates
    .map((candidate) => ({
      ...candidate,
      botId: candidate.botId.trim(),
      ownershipWeight: normalizeOwnershipWeight(candidate.ownershipWeight),
    }))
    .filter(
      (candidate) =>
        candidate.botId.length > 0 &&
        candidate.membershipStatus === ChatBotMembershipStatus.ACTIVE &&
        canExecuteActionsForBotState(candidate.lifecycleState) &&
        candidate.capabilityEligible &&
        !hasStructuredAccessLoss(candidate.botAccessState) &&
        !membershipExplicitlyLacksAccess(candidate.permissionsSnapshot),
    );
  if (eligibleCandidates.length === 0) {
    return null;
  }

  let selectedBotId: string | null = null;
  let selectedScore = Number.NEGATIVE_INFINITY;
  for (const candidate of eligibleCandidates) {
    const score = calculateWeightedRendezvousScore(
      normalizedEntityKey,
      candidate.botId,
      candidate.ownershipWeight,
    );
    if (
      score > selectedScore ||
      (score === selectedScore && (selectedBotId === null || candidate.botId < selectedBotId))
    ) {
      selectedBotId = candidate.botId;
      selectedScore = score;
    }
  }

  return selectedBotId;
}

export function resolveStableMaxBotOwnershipBotId(
  entityKey: string,
  candidates: readonly MaxBotOwnershipCandidate[],
  options: StableMaxBotOwnershipAssignmentOptions = {},
): string | null {
  const currentOwnerBotId = options.currentOwnerBotId?.trim() || null;
  if (currentOwnerBotId && options.rebalance !== true) {
    const currentOwner = candidates.find(
      (candidate) => candidate.botId.trim() === currentOwnerBotId,
    );
    if (currentOwner && isMaxBotOwnershipCandidateEligible(currentOwner)) {
      return currentOwnerBotId;
    }
  }

  return resolveWeightedRendezvousOwnerBotId(entityKey, candidates);
}

export function isMaxBotOwnershipCandidateEligible(candidate: MaxBotOwnershipCandidate): boolean {
  return (
    candidate.botId.trim().length > 0 &&
    candidate.membershipStatus === ChatBotMembershipStatus.ACTIVE &&
    canExecuteActionsForBotState(candidate.lifecycleState) &&
    candidate.capabilityEligible &&
    !hasStructuredAccessLoss(candidate.botAccessState) &&
    !membershipExplicitlyLacksAccess(candidate.permissionsSnapshot)
  );
}

function hasStructuredAccessLoss(state: ChatBotAccessState | null | undefined): boolean {
  return state === ChatBotAccessState.DENIED || state === ChatBotAccessState.LOST;
}

function calculateWeightedRendezvousScore(
  entityKey: string,
  botId: string,
  ownershipWeight: number,
): number {
  const digest = createHash('sha256').update(entityKey).update('\0').update(botId).digest();
  const hashInteger = Number(digest.readBigUInt64BE(0) >> 11n);
  const uniform = (hashInteger + 1) / (MAX_HASH_INTEGER + 1);
  return Math.log(uniform) / ownershipWeight;
}

function normalizeOwnershipWeight(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}
