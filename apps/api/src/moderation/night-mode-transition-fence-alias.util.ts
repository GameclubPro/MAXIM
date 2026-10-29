import { buildNightModeTransitionJobId } from './night-mode-transition.queue';
import { resolveNightModeLegacyRecoveryTime } from './night-mode-recovery-time-compat.util';
import {
  resolveNightModeTransitionSessionAliases,
  resolveNightModeTransitionSessionCloseAt,
  resolveNightModeTransitionSessionOpenAt,
  type NightModeTransitionKind,
} from './night-mode-transition-time.util';

/** FLAG: Old identities can only deny an effect, never authorize a SEND or a ledger reset. */
export function matchesNightModeTransitionFenceAlias(
  current: {
    chatId: string;
    transition: NightModeTransitionKind;
    sessionKey: string;
    jobId: string;
  },
  blocked: { sessionKey: string | null; jobId: string | null },
): boolean {
  if (current.sessionKey === blocked.sessionKey && current.jobId === blocked.jobId) return true;
  if (
    !blocked.sessionKey ||
    !blocked.jobId ||
    !resolveNightModeTransitionSessionAliases(current.sessionKey).includes(blocked.sessionKey)
  )
    return false;
  const canonical =
    current.transition === 'close'
      ? resolveNightModeTransitionSessionCloseAt(blocked.sessionKey)
      : resolveNightModeTransitionSessionOpenAt(blocked.sessionKey);
  return [
    canonical,
    resolveNightModeLegacyRecoveryTime(blocked.sessionKey, current.transition),
  ].some(
    (at) =>
      at &&
      buildNightModeTransitionJobId(
        current.chatId,
        current.transition,
        at.toISOString(),
        blocked.sessionKey!,
      ) === blocked.jobId,
  );
}
