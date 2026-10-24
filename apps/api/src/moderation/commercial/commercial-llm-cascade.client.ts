import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CommercialLlmError } from './commercial-llm.client';
import type {
  CommercialLlmClassifier,
  CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import type {
  CommercialLlmWorkstationMailbox,
  WorkstationOutcome,
} from './commercial-llm-workstation.mailbox';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';

export class CommercialLlmCascadeClient implements CommercialLlmClassifier {
  constructor(
    private readonly primary: Pick<CommercialLlmWorkstationMailbox, 'classify'>,
    private readonly secondary: CommercialLlmClassifier,
    private readonly canStartSecondary: () => Promise<boolean>,
    private readonly auditNegative: () => boolean = () => randomInt(10) === 0,
  ) {}

  async classify(
    excerpt: string,
    signal?: AbortSignal,
    mayContinue?: () => Promise<boolean>,
  ): Promise<CommercialLlmObservationResult> {
    const startedAt = performance.now();
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    let first: WorkstationOutcome;
    try {
      first = await this.primary.classify(excerpt, signal);
    } catch {
      first = { outcome: 'FAILED' };
    }
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    const primary = first.outcome === 'COMPLETE' ? first.result : null;
    const audit = primary?.classification === 'NOT_COMMERCIAL' && this.auditNegative();
    const cascade = {
      version: COMMERCIAL_LLM_CASCADE_VERSION,
      primaryModelSha256: COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256,
      ...(primary
        ? {
            primaryClassification: primary.classification,
            primaryDurationMs: primary.durationMs,
          }
        : {}),
    };
    if (primary?.classification === 'NOT_COMMERCIAL' && !audit) {
      return {
        ...primary,
        durationMs: Math.round(performance.now() - startedAt),
        cascade: { ...cascade, route: 'primary' },
      };
    }
    // FLAG: Positives and uncertainty always require 9B; pressure can shed the whole observation.
    // Neither model's answer or its self-reported confidence grants a moderation effect.
    if (
      signal?.aborted ||
      !(await this.canStartSecondary()) ||
      (mayContinue && !(await mayContinue())) ||
      signal?.aborted
    )
      throw new CommercialLlmError('ABORTED');
    const result = await this.secondary.classify(excerpt, signal);
    return {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
      cascade: {
        ...cascade,
        route: primary
          ? audit
            ? 'secondary_audit'
            : 'secondary_' + primary.classification.toLowerCase()
          : 'secondary_' + first.outcome.toLowerCase(),
        secondaryDurationMs: result.durationMs,
      },
    };
  }
}
