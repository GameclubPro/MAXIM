import { UnrecoverableError } from 'bullmq';
import type { ChatSettings } from '../prisma/prisma-client';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { isAmbiguousMaxMutationError } from '../max/max-send-ambiguity.util';
import { resolveDuplicateFlowConfig } from './duplicate-flow-policy';
import { DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS } from './duplicate-state';
import type { DuplicateAction } from './rule-engine.contract';

export function canResolveAdminAccess(client: unknown): boolean {
  if (!client || typeof client !== 'object') {
    return false;
  }

  const candidate = client as {
    getChatMembersAccess?: unknown;
    getChatAdminIds?: unknown;
  };
  return (
    typeof candidate.getChatMembersAccess === 'function' ||
    typeof candidate.getChatAdminIds === 'function'
  );
}

export function resolveBanFailureAmbiguity(
  error: unknown,
  terminalPermissionError: boolean,
  rethrowPreDispatchFailure = false,
): boolean {
  const mutationAttempted = wasMaxMemberMutationAttempted(error);
  if (
    rethrowPreDispatchFailure &&
    !mutationAttempted &&
    !terminalPermissionError &&
    !(error instanceof UnrecoverableError)
  ) {
    throw error;
  }
  return mutationAttempted && isAmbiguousMaxMutationError(error);
}

export function throwIfDuplicateMuteNotApplied(action: DuplicateAction, applied: boolean): void {
  if (action === 'MUTE' && !applied) {
    throw new Error('Duplicate mute sanction could not be persisted');
  }
}

export function classifyDuplicateEventTime(params: {
  eventTimestampMs?: number;
  windowSec: number;
  nowMs?: number;
}): string | null {
  const eventTimestampMs = Math.trunc(params.eventTimestampMs ?? Number.NaN);
  const windowSec = Math.trunc(params.windowSec);
  const nowMs = Math.trunc(params.nowMs ?? Date.now());
  if (
    !Number.isSafeInteger(eventTimestampMs) ||
    eventTimestampMs <= 0 ||
    !Number.isSafeInteger(windowSec) ||
    windowSec <= 0 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs <= 0
  ) {
    return null;
  }

  const ageMs = nowMs - eventTimestampMs;
  if (ageMs > windowSec * 1_000) {
    return `text duplicate event is ${ageMs}ms old, outside the ${windowSec}s window`;
  }
  if (ageMs < -DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS) {
    return `text duplicate event is ${Math.abs(ageMs)}ms ahead of the server clock`;
  }
  return null;
}

export function resolveEventTimeSkipReason(
  settings: ChatSettings,
  eventTimestampMs?: number,
): string | null {
  return classifyDuplicateEventTime({
    eventTimestampMs,
    windowSec: resolveDuplicateFlowConfig(settings).windowSec,
  });
}
