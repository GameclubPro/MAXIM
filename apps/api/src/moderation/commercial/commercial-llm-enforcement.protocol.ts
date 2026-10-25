import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';
import {
  fingerprintCommercialDeleteSettings,
  fingerprintCommercialDeleteText,
  type CommercialDeleteSettings,
} from './commercial-delete-binding';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  parseCommercialLlmDecision,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_CASCADE_VERSION,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY,
} from './commercial-llm-workstation.protocol';

export const COMMERCIAL_LLM_DELETE_RULE_CODE = 'COMMERCIAL_LLM_DELETE';
export const COMMERCIAL_LLM_ENFORCEMENT_VERSION = 1;
export const COMMERCIAL_LLM_EFFECT_MAX_AGE_MS = 60_000;
export const COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS = 20_000;
export const COMMERCIAL_LLM_PENDING_MAX_AGE_MS = 3_000;
export const COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256 = createHash('sha256')
  .update(
    JSON.stringify([
      COMMERCIAL_LLM_ENFORCEMENT_VERSION,
      COMMERCIAL_LLM_MODEL_SHA256,
      COMMERCIAL_LLM_PROMPT_SHA256,
      COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
      COMMERCIAL_LLM_WORKSTATION_IDENTITY,
      COMMERCIAL_LLM_CASCADE_VERSION,
    ]),
  )
  .digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const originSchema = z
  .object({
    sourceWebhookEventId: z.string().min(1).max(128),
    sourceReceivingBotId: z.string().min(1).max(100),
    sourceExecutionBotId: z.string().min(1).max(100),
    sourceEventAtMs: z.number().int().positive().safe(),
    sourceEvidenceVersion: z.literal(1),
  })
  .strict();
export const commercialLlmSourceSchema = z
  .object({
    version: z.literal(COMMERCIAL_LLM_ENFORCEMENT_VERSION),
    classifierSha256: z.literal(COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256),
    origin: originSchema,
    nonce: z.uuid(),
    chatId: z.string().min(1).max(100),
    messageId: z.string().min(1).max(200),
    userId: z.string().min(1).max(100),
    originBotId: z.string().min(1).max(100),
    eventAtMs: z.number().int().positive().safe(),
    deadlineAtMs: z.number().int().positive().safe(),
    sourceSha256: sha,
    settingsSha256: sha,
  })
  .strict();
export type CommercialLlmSource = z.infer<typeof commercialLlmSourceSchema>;
export const commercialLlmRequestSchema = z
  .object({
    source: commercialLlmSourceSchema,
    excerpt: z.string().min(1).max(2500),
    submittedAtMs: z.number().int().positive().safe(),
    worker: z.uuid(),
  })
  .strict();
export type CommercialLlmRequest = z.infer<typeof commercialLlmRequestSchema>;

export function commercialLlmSourceCurrent(source: CommercialLlmSource, now = Date.now()): boolean {
  return (
    source.origin.sourceEventAtMs === source.eventAtMs &&
    source.origin.sourceExecutionBotId === source.originBotId &&
    source.eventAtMs <= now + 5_000 &&
    source.deadlineAtMs === source.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS &&
    source.deadlineAtMs > now
  );
}

export type CommercialLlmOfferRejection =
  | 'filter_disabled'
  | 'invalid_origin'
  | 'empty_text'
  | 'oversized_text'
  | 'invalid_event_time'
  | 'stale_event'
  | 'unsanitized_contact';

export function prepareCommercialLlmOffer(
  input: {
    chatId: string;
    messageId: string;
    userId: string;
    originBotId?: string;
    text: string;
    eventAt: string | null;
    settings: CommercialDeleteSettings;
    origin?: z.infer<typeof originSchema>;
  },
  now = Date.now(),
):
  | { offer: { source: CommercialLlmSource; excerpt: string }; reason?: never }
  | { offer?: never; reason: CommercialLlmOfferRejection } {
  if (!input.settings.commercialAdsFilterEnabled) return { reason: 'filter_disabled' };
  if (!input.origin || !input.originBotId) return { reason: 'invalid_origin' };
  if (!input.text.trim()) return { reason: 'empty_text' };
  if (input.text.length > 2500) return { reason: 'oversized_text' };
  if (!input.eventAt) return { reason: 'invalid_event_time' };
  const eventAtMs = Date.parse(input.eventAt);
  // FLAG: Admission never renews the event deadline or accepts historical/replayed sources.
  if (!Number.isFinite(eventAtMs)) return { reason: 'invalid_event_time' };
  if (eventAtMs < now - 10_000 || eventAtMs > now + 5_000) return { reason: 'stale_event' };
  const excerpt = sanitizeCommercialCorpusText(input.text);
  if (!excerpt.trim() || excerpt.length > 2500 || hasResidualCommercialContactCandidate(excerpt))
    return { reason: 'unsanitized_contact' };
  const source = commercialLlmSourceSchema.safeParse({
    version: COMMERCIAL_LLM_ENFORCEMENT_VERSION,
    classifierSha256: COMMERCIAL_LLM_ENFORCEMENT_IDENTITY_SHA256,
    nonce: randomUUID(),
    origin: input.origin,
    chatId: input.chatId,
    messageId: input.messageId,
    userId: input.userId,
    originBotId: input.originBotId,
    eventAtMs,
    deadlineAtMs: eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
    sourceSha256: fingerprintCommercialDeleteText(input.text),
    settingsSha256: fingerprintCommercialDeleteSettings(input.settings),
  });
  return source.success && commercialLlmSourceCurrent(source.data, now)
    ? { offer: { source: source.data, excerpt } }
    : { reason: 'invalid_origin' };
}

export function buildCommercialLlmOffer(
  input: Parameters<typeof prepareCommercialLlmOffer>[0],
  now = Date.now(),
): { source: CommercialLlmSource; excerpt: string } | null {
  return prepareCommercialLlmOffer(input, now).offer ?? null;
}

export function commercialLlmSourceKey(source: CommercialLlmSource): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}

// FLAG: Historical SHADOW rows never enter this boundary. A newly admitted source needs
// a successful, pinned server answer; audited disagreement with a local negative is a KEEP.
export function commercialLlmMayDelete(result: CommercialLlmObservationResult): boolean {
  return (
    parseCommercialLlmDecision({
      classification: result.classification,
      reasonCodes: result.reasonCodes,
    })?.classification === 'COMMERCIAL' &&
    result.modelSha256 === COMMERCIAL_LLM_MODEL_SHA256 &&
    result.promptSha256 === COMMERCIAL_LLM_PROMPT_SHA256 &&
    result.runtimeImageSha256 === COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256 &&
    result.chatTemplateSha256 === COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256 &&
    result.policyVersion === COMMERCIAL_LLM_POLICY_VERSION &&
    result.cascade?.version === COMMERCIAL_LLM_CASCADE_VERSION &&
    result.cascade.primaryModelSha256 === COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelSha256 &&
    result.cascade.route.startsWith('secondary_') &&
    result.cascade.primaryClassification !== 'NOT_COMMERCIAL'
  );
}
