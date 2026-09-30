import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { digestDuplicateContent } from './message-duplicate-content';

@Injectable()
export class MessageDuplicateAdmissionService {
  constructor(private readonly prisma: PrismaService) {}

  async register(input: {
    jobId: string;
    chatId: string;
    messageId: string;
  }): Promise<{ registration: 'initial' | 'retry'; admittedAtMs: number }> {
    const dedupeKey = `message-duplicate-admission:v1:${digestDuplicateContent(input.jobId)}`;
    const created = await this.prisma.moderationViolationMessageClaim.createMany({
      data: [
        {
          dedupeKey,
          chatId: input.chatId,
          messageId: input.messageId,
          userId: 'message-duplicate',
          messageActionKey: null,
          ruleCode: 'MESSAGE_DUPLICATE_ADMISSION',
          updateType: 'message_duplicate_admission',
        },
      ],
      skipDuplicates: true,
    });
    const stored = await this.prisma.moderationViolationMessageClaim.findUnique({
      where: { dedupeKey },
      select: {
        chatId: true,
        messageId: true,
        messageActionKey: true,
        ruleCode: true,
        updateType: true,
        createdAt: true,
      },
    });
    if (
      !stored ||
      stored.chatId !== input.chatId ||
      stored.messageId !== input.messageId ||
      stored.messageActionKey !== null ||
      stored.ruleCode !== 'MESSAGE_DUPLICATE_ADMISSION' ||
      stored.updateType !== 'message_duplicate_admission'
    )
      throw new Error('Message duplicate admission could not be reconciled');
    // FLAG: A missing Redis permit must never become true merely because BullMQ or
    // its retained job disappeared. Only the first committed admission can mint one.
    return {
      registration: created.count > 0 ? 'initial' : 'retry',
      admittedAtMs: stored.createdAt.getTime(),
    };
  }
}
