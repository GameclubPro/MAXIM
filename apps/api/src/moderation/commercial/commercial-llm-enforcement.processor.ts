import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import { withCommercialLlmEffectOrigin } from './commercial-llm-effect-origin';
import type { CommercialLlmEnforcementMailbox } from './commercial-llm-enforcement.mailbox';
import type { CommercialLlmShadowLease } from './commercial-llm-shadow.lease';
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
    private readonly lease: CommercialLlmShadowLease,
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
    let token: string | null = null;
    let registrationStarted = false;
    try {
      if (signal.aborted || !(await this.mayRun())) return { outcome: 'pressure_skipped' };
      token = await this.lease.acquire();
      if (!token) return { outcome: 'admission_skipped' };
      const source = item.request.source;
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS),
      ]);
      const valid = async () =>
        !workSignal.aborted &&
        commercialLlmSourceCurrent(source) &&
        (await this.mailbox.ownsWorker(worker)) &&
        (await this.mailbox.owns(item.raw)) &&
        (await this.lease.owns(token!));
      if (!(await valid())) return { outcome: 'source_expired' };
      const result = await this.classifier.classify(item.request.excerpt, workSignal, valid);
      if (!(await valid())) return { outcome: 'source_expired' };
      if (!commercialLlmMayDelete(result))
        return {
          outcome: 'kept',
          classification: result.classification,
          durationMs: result.durationMs,
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
        durationMs: result.durationMs,
      };
    } catch {
      return { outcome: registrationStarted ? 'registration_unknown' : 'unavailable_skipped' };
    } finally {
      await this.mailbox.finish(item.raw).catch(() => undefined);
      if (token) await this.lease.release(token).catch(() => undefined);
    }
  }
}
