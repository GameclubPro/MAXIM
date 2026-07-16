export type NightModeTransitionNoticeRuleCode =
  | 'NIGHT_MODE_CLOSE_NOTICE'
  | 'NIGHT_MODE_OPEN_NOTICE';

export type NightModeTransitionAcceptedNoticeDetails = {
  chatId: string;
  messageId: string;
  botId: string | null;
  ruleCode: NightModeTransitionNoticeRuleCode;
  sessionKey: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
};

export class NightModeTransitionNoticeEventPersistenceError extends Error {
  readonly details: NightModeTransitionAcceptedNoticeDetails;

  constructor(details: NightModeTransitionAcceptedNoticeDetails, cause: unknown) {
    super(`Night mode ${details.ruleCode} event persistence failed after MAX accepted notice`);
    this.name = 'NightModeTransitionNoticeEventPersistenceError';
    this.details = details;
    (this as { cause?: unknown }).cause = cause;
  }
}

export function isNightModeTransitionNoticeEventPersistenceError(
  error: unknown,
): error is NightModeTransitionNoticeEventPersistenceError {
  if (error instanceof NightModeTransitionNoticeEventPersistenceError) {
    return true;
  }

  if (!error || typeof error !== 'object') {
    return false;
  }

  const record = error as {
    name?: unknown;
    details?: Partial<NightModeTransitionAcceptedNoticeDetails>;
  };
  return (
    record.name === 'NightModeTransitionNoticeEventPersistenceError' &&
    typeof record.details?.chatId === 'string' &&
    typeof record.details.messageId === 'string' &&
    (record.details.botId === null || typeof record.details.botId === 'string') &&
    (record.details.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE' ||
      record.details.ruleCode === 'NIGHT_MODE_OPEN_NOTICE') &&
    typeof record.details.sessionKey === 'string' &&
    typeof record.details.timezone === 'string' &&
    typeof record.details.startMinutes === 'number' &&
    typeof record.details.endMinutes === 'number'
  );
}
