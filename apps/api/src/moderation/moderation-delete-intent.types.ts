export const MODERATION_DELETE_INTENT_STATUSES = [
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
] as const;

export type ModerationDeleteIntentStatus = (typeof MODERATION_DELETE_INTENT_STATUSES)[number];
export type ModerationDeleteIntentMode = 'off' | 'shadow' | 'canary' | 'on';
export type ModerationDeleteIntentRollout = 'off' | 'observed' | 'execute';

export type ModerationDeleteEventInput = {
  reasonKey: string;
  ruleCode: string;
  userId?: string | null;
  eventType?: 'MESSAGE' | 'MEMBER_ACTION' | 'SYSTEM' | null;
  maskedExcerpt?: string | null;
  score?: number;
  metadata?: unknown;
};

export type EnsureModerationDeleteIntentInput = {
  chatId: string;
  messageId: string;
  reasonKey: string;
  ruleCode?: string;
  subjectUserId?: string | null;
  sourceMessageAt?: Date | string | null;
  entityType?: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind?: 'user' | 'bot' | null;
  originBotId?: string | null;
  routingPolicy?: 'delete_capable' | 'origin_first' | 'origin_only';
  executeAt?: Date | string | null;
  retryUntilAt?: Date | string | null;
  event?: Omit<ModerationDeleteEventInput, 'reasonKey' | 'ruleCode'>;
};

export type ModerationDeleteIntentSnapshot = {
  id: string;
  chatId: string;
  messageId: string;
  status: ModerationDeleteIntentStatus;
  executeAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  attemptCount: number;
  lastBotId: string | null;
  succeededBotId: string | null;
  deleteDispatchStartedAt: Date | null;
  deleteDispatchStartedBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
};

export type EnsureModerationDeleteIntentResult = {
  intentId: string | null;
  rollout: ModerationDeleteIntentRollout;
  status: ModerationDeleteIntentStatus | null;
};

export type ModerationDeleteAttemptResult =
  | { kind: 'off'; confirmed: false; intentId: null; status: null }
  | {
      kind: 'observed';
      confirmed: false;
      intentId: string;
      status: ModerationDeleteIntentStatus;
    }
  | {
      kind: 'confirmed';
      confirmed: true;
      intentId: string;
      status: 'SUCCEEDED';
      botId: string | null;
    }
  | {
      kind: 'already_absent';
      confirmed: true;
      intentId: string;
      status: 'ALREADY_ABSENT';
      botId: null;
    }
  | {
      kind: 'waiting_capability';
      confirmed: false;
      intentId: string;
      status: 'WAITING_CAPABILITY';
    }
  | { kind: 'ambiguous'; confirmed: false; intentId: string; status: 'AMBIGUOUS' }
  | {
      kind: 'pending';
      confirmed: false;
      intentId: string;
      status: 'PENDING' | 'RETRYABLE' | 'IN_PROGRESS';
    }
  | { kind: 'expired'; confirmed: false; intentId: string; status: 'EXPIRED' }
  | {
      kind: 'terminal';
      confirmed: false;
      intentId: string;
      status: 'FAILED_TERMINAL';
    };
