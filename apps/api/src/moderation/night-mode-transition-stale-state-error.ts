export class NightModeTransitionStaleStateError extends Error {
  readonly code = 'night_mode_transition_stale_state';

  constructor(chatId: string) {
    super(`Night mode transition state changed before dispatch (${chatId})`);
    this.name = 'NightModeTransitionStaleStateError';
  }
}

export function isNightModeTransitionStaleStateError(
  error: unknown,
): error is NightModeTransitionStaleStateError {
  return (
    error instanceof NightModeTransitionStaleStateError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'night_mode_transition_stale_state')
  );
}
