import { z } from 'zod';
import type { ChatSettings } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MaxActionLedgerContext } from '../../max/max-client.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import type { DuplicateDecision, DuplicateHit } from '../rule-engine.contract';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { digestDuplicateContent } from './message-duplicate-content';
import {
  messageDuplicateBindingSchema,
  parseMessageDuplicateBinding,
} from './message-duplicate-state';

const stageSchema = z
  .object({
    kind: z.enum(['hit', 'WARN', 'MUTE']),
    repeatCount: z.number().int().min(1).max(20),
    threshold: z.number().int().min(1).max(20).nullable(),
  })
  .strict()
  .refine((stage) => (stage.kind === 'hit') === (stage.threshold === null));

const duplicateNoticeProofSchema = z
  .object({
    version: z.literal(3),
    chatId: z.string().trim().min(1).max(512),
    intentId: z.string().trim().min(1).max(512),
    reasonKey: z.string().trim().min(1).max(512),
    deadlineAtMs: z.number().int().positive().safe(),
    noticePolicySha256: z.string().regex(/^[a-f0-9]{64}$/),
    binding: messageDuplicateBindingSchema,
    stage: stageSchema,
  })
  .strict()
  .refine(
    ({ binding, reasonKey, deadlineAtMs, stage }) =>
      binding.version === 3 &&
      binding.enforcementScope === 'full' &&
      !!binding.authorization &&
      !!binding.original &&
      reasonKey === `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}` &&
      deadlineAtMs <= binding.authorization.deadlineAtMs &&
      deadlineAtMs <= binding.original.expiresAtMs &&
      (stage.kind === 'hit'
        ? !binding.sanction
        : binding.sanction?.action === stage.kind &&
          binding.sanction.repeatCount === stage.repeatCount &&
          binding.sanction.threshold === stage.threshold),
  );

export type MessageDuplicateNoticeProof = z.infer<typeof duplicateNoticeProofSchema>;

export function readMessageDuplicateNoticeProof(
  value: unknown,
): MessageDuplicateNoticeProof | null {
  const result = duplicateNoticeProofSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function messageDuplicateNoticeSettingsDigest(settings: ChatSettings): string {
  return digestDuplicateContent({
    version: 1,
    flow: resolveDuplicateFlowConfig(settings),
    muteHours: settings.duplicateMuteEnabled ? settings.duplicateMuteDurationHours : null,
    enabled: settings.duplicateBotMessageEnabled,
    text: settings.duplicateBotMessageText,
    buttons: settings.duplicateBotButtons,
    button: [
      settings.duplicateBotButtonEnabled,
      settings.duplicateBotButtonUrl,
      settings.duplicateBotButtonText,
    ],
    contact: [settings.duplicateAdminContactButtonEnabled, settings.duplicateAdminContactButtonUrl],
    speech: settings.botSpeechStyle,
  });
}

export async function buildMessageDuplicateNoticeContext(
  prisma: Pick<PrismaService, 'moderationDeleteIntent'>,
  input: EnsureModerationDeleteIntentInput,
  noticePolicySha256: string | undefined,
  outcome: Pick<DuplicateHit, 'count'> | Pick<DuplicateDecision, 'action' | 'count' | 'threshold'>,
): Promise<MaxActionLedgerContext> {
  const binding = parseMessageDuplicateBinding(input.event?.metadata);
  const intent = await prisma.moderationDeleteIntent.findUnique({
    where: {
      chatId_messageId: { chatId: input.chatId, messageId: input.messageId },
    },
    select: { id: true, subjectUserId: true, retryUntilAt: true },
  });
  // FLAG: Bind the original v3 grant and stage. Never mint notice authority from a
  // delivery-time policy or create a sanction merely to explain a delete-only hit.
  const proof = readMessageDuplicateNoticeProof({
    version: 3,
    chatId: input.chatId,
    intentId: intent?.id,
    reasonKey: input.reasonKey,
    deadlineAtMs: input.retryUntilAt ? new Date(input.retryUntilAt).getTime() : undefined,
    noticePolicySha256,
    binding,
    stage: {
      kind: 'action' in outcome ? outcome.action : 'hit',
      repeatCount: outcome.count,
      threshold: 'threshold' in outcome ? outcome.threshold : null,
    },
  });
  if (!proof || intent?.subjectUserId !== binding?.senderId)
    throw new Error('Message duplicate notice original authority unavailable');
  return { duplicateNotice: proof };
}
