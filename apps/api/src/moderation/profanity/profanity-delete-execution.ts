import {
  PROFANITY_DELETE_RULE_CODE,
  ProfanityDeleteGuardRejectedError,
  type ProfanityDeleteGuardService,
} from './profanity-delete-guard.service';

export type ModerationDeleteExecutionResult = {
  accepted: boolean;
  gone: boolean;
  deleted: boolean;
  eventPersistedByIntent: boolean;
  botId: string | null;
  profanityVerified?: true;
};

export type ProfanityDeleteMutationHooks = {
  beforeAttempt(): void;
  beforeDeleteMutation(botId?: string): Promise<void>;
};

class ProfanityDeleteAlreadyAbsentError extends Error {}

export async function executeProfanityGuardedLegacyDelete(params: {
  input: {
    chatId: string;
    messageId: string;
    ruleCode?: string;
    subjectUserId?: string | null;
    event?: { score?: number };
  };
  scheduled: boolean;
  guard?: Pick<ProfanityDeleteGuardService, 'assertMessageStillActionable'>;
  execute(hooks?: ProfanityDeleteMutationHooks): Promise<{ ok: boolean; botId: string | null }>;
}): Promise<ModerationDeleteExecutionResult> {
  const isProfanity = params.input.ruleCode === PROFANITY_DELETE_RULE_CODE;
  if (isProfanity && !params.guard) {
    throw new Error('Profanity delete guard is unavailable');
  }

  let profanityVerified = false;
  const hooks: ProfanityDeleteMutationHooks | undefined = isProfanity
    ? {
        // FLAG: Verification belongs to one transport attempt, never an earlier route or retry.
        beforeAttempt: () => {
          profanityVerified = false;
        },
        beforeDeleteMutation: async (botId) => {
          profanityVerified = false;
          const result = await params.guard!.assertMessageStillActionable({
            chatId: params.input.chatId,
            messageId: params.input.messageId,
            subjectUserId: params.input.subjectUserId ?? null,
            botId,
            minimumScore: params.input.event?.score,
          });
          if (result === 'absent') {
            throw new ProfanityDeleteAlreadyAbsentError();
          }
          profanityVerified = result === 'allowed';
        },
      }
    : undefined;

  let execution: { ok: boolean; botId: string | null };
  try {
    execution = await params.execute(hooks);
  } catch (error: unknown) {
    if (
      !(error instanceof ProfanityDeleteGuardRejectedError) &&
      !(error instanceof ProfanityDeleteAlreadyAbsentError)
    ) {
      throw error;
    }
    return {
      accepted: error instanceof ProfanityDeleteAlreadyAbsentError,
      gone: error instanceof ProfanityDeleteAlreadyAbsentError,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
    };
  }
  const deleted = execution.ok && !params.scheduled;
  return {
    accepted: execution.ok,
    gone: deleted,
    deleted,
    eventPersistedByIntent: false,
    botId: execution.botId,
    ...(deleted && profanityVerified ? { profanityVerified: true as const } : {}),
  };
}
