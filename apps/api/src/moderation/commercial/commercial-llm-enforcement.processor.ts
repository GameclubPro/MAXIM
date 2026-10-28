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
    private readonly classifier:
      | CommercialLlmClassifier
      | ((item: {
          request: NonNullable<
            Awaited<ReturnType<CommercialLlmEnforcementMailbox['take']>>
          >['request'];
          raw: string;
          deadlineAtMs: number;
        }) => CommercialLlmClassifier),
    private readonly intents: Pick<ModerationDeleteIntentService, 'ensureIntent'>,
    private readonly mayRun: () => Promise<boolean>,
  ) {}

  async run(
    worker: string,
    signal: AbortSignal,
  ): Promise<Record<string, string | number | boolean>> {
    const item = await this.mailbox.take(worker);
    if (!item) return { outcome: 'idle' };
    const source = item.request.source;
    const trace = {
      traceId: source.nonce,
      admittedAtMs: item.request.submittedAtMs,
      admissionWindowStartAt: new Date(
        Math.floor(item.request.submittedAtMs / 60_000) * 60_000,
      ).toISOString(),
    };
    const primaryWaitMs = Math.max(0, Date.now() - item.request.submittedAtMs);
    let registrationStarted = false;
    try {
      if (signal.aborted || !(await this.mayRun()))
        return { outcome: 'pressure_skipped', ...trace };
      const deadlineAtMs = Math.min(
        Date.now() + COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS,
        source.deadlineAtMs,
      );
      const workSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(Math.max(1, deadlineAtMs - Date.now())),
      ]);
      const valid = async () =>
        !workSignal.aborted &&
        commercialLlmSourceCurrent(source) &&
        (await this.mailbox.ownsWorker(worker)) &&
        (await this.mailbox.owns(item.raw));
      if (!(await valid())) return { outcome: 'source_expired', ...trace };
      const classifier =
        typeof this.classifier === 'function'
          ? this.classifier({ ...item, deadlineAtMs })
          : this.classifier;
      const result = await classifier.classify(item.request.excerpt, workSignal, valid);
      if (!(await valid())) return { outcome: 'source_expired', ...trace };
      const observation = {
        classification: result.classification,
        ...trace,
        primaryWaitMs,
        durationMs: result.durationMs,
        ...(result.cascade ? { route: result.cascade.route } : {}),
        ...(result.pool
          ? {
              route: result.pool.route,
              nodeId: result.pool.nodeId,
              poolPolicy: result.pool.policy,
              attempts: result.pool.attempts,
              ...(result.pool.primaryDurationMs !== undefined
                ? { primaryDurationMs: result.pool.primaryDurationMs }
                : {}),
              ...(result.pool.consultationDurationMs !== undefined
                ? { consultationDurationMs: result.pool.consultationDurationMs }
                : {}),
              ...(result.pool.consultationOutcome
                ? { consultationOutcome: result.pool.consultationOutcome }
                : {}),
            }
          : {}),
        ...(result.cascade?.primaryDurationMs !== undefined
          ? { primaryDurationMs: result.cascade.primaryDurationMs }
          : {}),
        ...(result.cascade?.secondaryDurationMs !== undefined
          ? { secondaryDurationMs: result.cascade.secondaryDurationMs }
          : {}),
        ...(result.cascade?.auditOutcome === 'capacity_skipped'
          ? { auditOutcome: 'capacity_skipped' }
          : {}),
      };
      if (!commercialLlmMayDelete(result, source))
        return {
          outcome: result.classification === 'UNSURE' ? 'unsure' : 'kept',
          ...observation,
        };
      if (!(await this.mailbox.prove(item.raw, source)) || !(await valid()))
        return { outcome: 'source_expired', ...trace };
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
                ...(result.pool ? { pool: result.pool } : { cascadeRoute: result.cascade!.route }),
              },
            },
          }),
      );
      return {
        outcome: receipt.rollout === 'execute' ? 'delete_registered' : 'delete_not_admitted',
        ...observation,
      };
    } catch (error) {
      if (registrationStarted) return { outcome: 'registration_unknown', ...trace };
      return {
        ...trace,
        outcome:
          error instanceof CommercialLlmError && error.kind === 'BUSY'
            ? 'secondary_capacity_skipped'
            : 'unavailable_skipped',
        failureKind: error instanceof CommercialLlmError ? error.kind : 'UNAVAILABLE',
      };
    } finally {
      await this.mailbox.finish(item.raw, worker).catch(() => undefined);
    }
  }
}
