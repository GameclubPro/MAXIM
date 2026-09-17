import type { Logger } from '@nestjs/common';
import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import {
  executeProfanityGuardedLegacyDelete,
  type ModerationDeleteExecutionResult,
  type ProfanityDeleteMutationHooks,
} from './profanity/profanity-delete-execution';
import type { ProfanityDeleteGuardService } from './profanity/profanity-delete-guard.service';
import type { CommercialDeleteGuardService } from './commercial/commercial-delete-guard.service';
import { executeCommercialGuardedLegacyDelete } from './commercial/commercial-delete-execution';
import { TRAFFIC_PROTECTION_DELETE_RULE_CODES } from './traffic-protection';

export async function executeDurableModerationDelete(params: {
  input: EnsureModerationDeleteIntentInput;
  service?: Pick<ModerationDeleteIntentService, 'ensureAndAttempt' | 'getRolloutForInput'>;
  beforeDeleteMutation?: () => Promise<void>;
  legacy: () => Promise<ModerationDeleteExecutionResult>;
  logger: Pick<Logger, 'warn'>;
}): Promise<ModerationDeleteExecutionResult> {
  const { input, service } = params;
  const trafficOwned = TRAFFIC_PROTECTION_DELETE_RULE_CODES.has(input.ruleCode ?? '');
  // FLAG: Opt-in traffic decisions cannot use legacy deletion even during an outage
  // or a base rollout downgrade. Their current-policy guard lives in durable dispatch.
  if (trafficOwned && !service)
    throw new Error('Traffic protection requires guarded durable deletion');
  if (service) {
    try {
      const result = await service.ensureAndAttempt(
        input,
        params.beforeDeleteMutation
          ? { beforeDeleteMutation: params.beforeDeleteMutation }
          : undefined,
      );
      const executeExclusively = trafficOwned || service.getRolloutForInput(input) === 'execute';
      if (result.kind !== 'off' && result.kind !== 'observed')
        return {
          accepted: result.kind !== 'expired' && result.kind !== 'terminal',
          gone: result.confirmed,
          deleted: result.kind === 'confirmed',
          eventPersistedByIntent: result.kind === 'confirmed',
          botId: result.kind === 'confirmed' ? result.botId : null,
          ...(result.kind === 'confirmed' && result.profanityVerified
            ? { profanityVerified: true as const }
            : {}),
          ...(result.kind === 'confirmed' &&
          result.commercialVerified &&
          result.commercialVerifiedReasonKeys?.includes(input.reasonKey)
            ? { commercialVerified: true as const }
            : {}),
        };
      if (executeExclusively)
        return {
          accepted: true,
          gone: false,
          deleted: false,
          eventPersistedByIntent: false,
          botId: null,
        };
    } catch (error: unknown) {
      if (trafficOwned || service.getRolloutForInput(input) === 'execute') throw error;
      params.logger.warn(
        {
          chatId: input.chatId,
          messageId: input.messageId,
          ruleCode: input.ruleCode ?? input.reasonKey,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to persist shadow moderation delete intent; using legacy delete path',
      );
    }
  }
  return params.legacy();
}

export function executeGuardedModerationDelete(
  params: Omit<
    Parameters<typeof executeDurableModerationDelete>[0],
    'legacy' | 'beforeDeleteMutation'
  > & {
    options?: { delayMs?: number; beforeImmediateDeleteMutation?: () => Promise<void> };
    profanityGuard?: Pick<ProfanityDeleteGuardService, 'assertMessageStillActionable'>;
    commercialGuard?: Pick<CommercialDeleteGuardService, 'assertMessageStillActionable'>;
    legacyExecute(
      hooks?: ProfanityDeleteMutationHooks,
    ): Promise<{ ok: boolean; botId: string | null }>;
  },
): Promise<ModerationDeleteExecutionResult> {
  const scheduled = Boolean(params.options?.delayMs && params.options.delayMs > 0);
  return executeDurableModerationDelete({
    ...params,
    beforeDeleteMutation: params.options?.beforeImmediateDeleteMutation,
    legacy: () =>
      executeCommercialGuardedLegacyDelete({
        input: params.input,
        scheduled,
        guard: params.commercialGuard,
        execute: (commercialHooks) =>
          executeProfanityGuardedLegacyDelete({
            input: params.input,
            scheduled,
            guard: params.profanityGuard,
            execute: (profanityHooks) => params.legacyExecute(commercialHooks ?? profanityHooks),
          }),
      }),
  });
}
