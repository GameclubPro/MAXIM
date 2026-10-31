export type MaxApiRateLimitScope =
  | 'bot'
  | 'role_class'
  | 'chat'
  | 'message_target'
  | 'retention_fleet'
  | 'retention_chat'
  | 'retention_priority'
  | 'managed_refresh'
  | 'external_cooldown'
  | 'moderation_protection'
  | 'unknown';

export class MaxApiInternalRateLimitError extends Error {
  readonly code = 'MAX_API_INTERNAL_RATE_LIMIT';
  readonly preDispatch = true;

  constructor(
    message: string,
    readonly retryAfterMs: number,
    // FLAG: Diagnostic attribution only; never grants retry or mutation authority.
    readonly limitScope: MaxApiRateLimitScope = 'unknown',
  ) {
    super(message);
    this.name = 'MaxApiInternalRateLimitError';
  }
}
