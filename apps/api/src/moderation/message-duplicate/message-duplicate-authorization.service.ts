import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { digestDuplicateContent } from './message-duplicate-content';
import {
  MessageDuplicateOrderingStore,
  buildMessageDuplicateJobId,
} from './message-duplicate.queue';
import type { MessageDuplicateBinding } from './message-duplicate-state';
import { DUPLICATE_JOB_MAX_LIFETIME_MS } from '../photo-duplicate/photo-duplicate-ordering.store';

export function duplicateRevocationKey(
  chatId: string,
  messageId: string,
  eventTimestampMs: number,
): string {
  return `message-duplicate-revoked:v1:${digestDuplicateContent([chatId, messageId, eventTimestampMs])}`;
}

@Injectable()
export class MessageDuplicateAuthorizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordering: MessageDuplicateOrderingStore,
  ) {}

  async revoke(input: {
    chatId: string;
    messageId: string;
    senderId: string;
    eventTimestampMs: number;
  }): Promise<void> {
    if (!Number.isSafeInteger(input.eventTimestampMs) || input.eventTimestampMs <= 0) return;
    // FLAG: Persist the absorbing denial before Redis. Its separate key must never take
    // another rule's message action claim, and losing Redis must never undo this denial.
    await this.prisma.moderationViolationMessageClaim.createMany({
      data: [
        {
          dedupeKey: duplicateRevocationKey(input.chatId, input.messageId, input.eventTimestampMs),
          messageActionKey: null,
          chatId: input.chatId,
          userId: input.senderId,
          messageId: input.messageId,
          ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED',
          updateType: 'message_duplicate_authorization',
        },
      ],
      skipDuplicates: true,
    });
    await Promise.all(
      [undefined, 'IMAGE' as const].map(async (comparison) => {
        await this.ordering
          .revokeActionEligibility({
            chatId: input.chatId,
            jobId: buildMessageDuplicateJobId(
              input.chatId,
              input.messageId,
              input.eventTimestampMs,
              comparison,
            ),
            sourceCreatedAt: new Date(input.eventTimestampMs).toISOString(),
          })
          .catch(() => undefined);
      }),
    );
  }

  async isAllowed(chatId: string, binding: MessageDuplicateBinding): Promise<boolean> {
    const authority = binding.authorization;
    if (
      binding.version !== 3 ||
      !authority ||
      Date.now() >= authority.deadlineAtMs ||
      authority.deadlineAtMs >
        Math.min(binding.eventTimestampMs, authority.eventTimestampMs) +
          DUPLICATE_JOB_MAX_LIFETIME_MS
    )
      return false;
    const timestamps = new Set([binding.eventTimestampMs, authority.eventTimestampMs]);
    for (const timestamp of timestamps) {
      const revoked = await this.prisma.moderationViolationMessageClaim.findUnique({
        where: { dedupeKey: duplicateRevocationKey(chatId, binding.messageId, timestamp) },
        select: { id: true },
      });
      if (revoked) return false;
    }
    if (!authority.jobId)
      return (
        binding.compareMode !== 'IMAGE' && !binding.hasPhotos && binding.mediaHashes.length === 0
      );
    const expected = buildMessageDuplicateJobId(
      chatId,
      binding.messageId,
      authority.eventTimestampMs,
      binding.compareMode === 'IMAGE' ? 'IMAGE' : undefined,
    );
    if (authority.jobId !== expected) return false;
    return this.ordering.readActionEligibility({
      chatId,
      jobId: authority.jobId,
      sourceCreatedAt: new Date(authority.eventTimestampMs).toISOString(),
      deadlineAtMs: authority.deadlineAtMs,
    });
  }
}
