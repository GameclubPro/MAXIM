import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import { withCommercialLlmEffectOrigin } from './commercial-llm-effect-origin';
import type { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import { CommercialLlmError } from './commercial-llm.client';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import {
  commercialLlmMayDelete,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
  COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS,
} from './commercial-llm-enforcement.protocol';

export class CommercialLlmEnforcementProcessor {
  constructor(
    private readonly mailbox: CommercialLlmEnforcementMailbox,
    private readonly classifier: CommercialLlmClassifier,
    private readonly intents: Pick<ModerationDeleteIntentService, 'ensureIntent'>,
    private readonly mayRun: () => Promise<boolean>,
  ) {}

  async run(
    worker: string,
    signal: AbortSignal,
  ): Promise<Record<string, string | number | boolean>> {
    const item = await this.mailbox.take(worker);
    if (!item) return { outcome: 'idle' };
    await this.mailbox.withdraw(worker);
    let registrationStarted = false;
    try {
      if (signal.aborted || !(await this.mayRun())) return { outcome: 'pressure_skipped' };
      const source = item.request.source;
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS),
      ]);
      const valid = async () =>
        !workSignal.aborted &&
        commercialLlmSourceCurrent(source) &&
        (await this.mailbox.ownsWorker(worker)) &&
        (await this.mailbox.owns(item.raw));
      if (!(await valid())) return { outcome: 'source_expired' };
      const result = await this.classifier.classify(item.request.excerpt, workSignal, valid);
      if (!(await valid())) return { outcome: 'source_expired' };
      const observation = {
        classification: result.classification,
        durationMs: result.durationMs,
        ...(result.cascade ? { route: result.cascade.route } : {}),
        ...(result.cascade?.primaryDurationMs !== undefined
          ? { primaryDurationMs: result.cascade.primaryDurationMs }
          : {}),
        ...(result.cascade?.secondaryDurationMs !== undefined
          ? { secondaryDurationMs: result.cascade.secondaryDurationMs }
          : {}),
      };
      if (!commercialLlmMayDelete(result))
        return {
          outcome: 'kept',
          ...observation,
        };
      if (!(await this.mailbox.prove(item.raw, source)) || !(await valid()))
        return { outcome: 'source_expired' };
      // FLAG: Only this fresh successful classification enters the durable DELETE journal.
      // No strike, ban, notice or replay is inferred from intent registration or a stored receipt.
      registrationStarted = true;
      const receipt = await withCommercialLlmEffectOrigin(
        source,
        () => this.mailbox.hasProof(source),
        () =>
          this.intents.ensureIntent({
            chatId: source.chatId,
            messageId: source.messageId,
            subjectUserId: source.userId,
            originBotId: source.originBotId,
            routingPolicy: 'delete_capable',
            entityType: 'CHAT',
            messageAuthorKind: 'user',
            sourceMessageAt: new Date(source.eventAtMs),
            retryUntilAt: new Date(source.deadlineAtMs),
            ruleCode: COMMERCIAL_LLM_DELETE_RULE_CODE,
            reasonKey: `${COMMERCIAL_LLM_DELETE_RULE_CODE}:${commercialLlmSourceKey(source)}`,
            event: {
              userId: source.userId,
              eventType: 'MESSAGE',
              score: 1,
              metadata: {
                source: 'commercial_ai',
                commercialLlmSource: source,
                modelSha256: result.modelSha256,
                promptSha256: result.promptSha256,
                reasonCodes: result.reasonCodes,
                cascadeRoute: result.cascade!.route,
              },
            },
          }),
      );
      return {
        outcome: receipt.rollout === 'execute' ? 'delete_registered' : 'delete_not_admitted',
        ...observation,
      };
    } catch (error) {
      if (registrationStarted) return { outcome: 'registration_unknown' };
      return {
        outcome:
          error instanceof CommercialLlmError && error.kind === 'BUSY'
            ? 'secondary_capacity_skipped'
            : 'unavailable_skipped',
        failureKind: error instanceof CommercialLlmError ? error.kind : 'UNAVAILABLE',
      };
    } finally {
      await this.mailbox.finish(item.raw).catch(() => undefined);
    }
  }
}
