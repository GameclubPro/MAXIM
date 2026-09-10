import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, UnrecoverableError, type Job } from 'bullmq';
import { z } from 'zod';
import { ModerationExecutionService } from '../moderation-execution.service';
import { PhotoDuplicateSourceNotReadyError } from '../photo-duplicate/photo-duplicate.queue';
import { MessageDuplicateMediaDeferredError } from './message-duplicate-media.service';
import {
  MESSAGE_DUPLICATE_QUEUE,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';

export const messageDuplicateJobSchema = z
  .object({
    version: z.literal(1),
    webhookEventId: z.string().min(1).max(200),
    chatId: z.string().regex(/^-[1-9][0-9]{0,19}$/),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER / 2 - 1),
    controlRevision: z.number().int().positive(),
    settingsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCreatedAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
    actionEligible: z.boolean(),
    idempotencyKey: z.string().regex(/^message-duplicate__[a-f0-9]{64}$/),
  })
  .strict()
  .refine((value) => Date.parse(value.sourceCreatedAt) === value.eventTimestampMs);

@Processor(MESSAGE_DUPLICATE_QUEUE, { concurrency: 2 })
export class MessageDuplicateProcessor extends WorkerHost {
  constructor(
    private readonly execution: ModerationExecutionService,
    private readonly ordering: MessageDuplicateOrderingStore,
  ) {
    super();
  }

  async process(job: Job<MessageDuplicateJob>, token?: string): Promise<void> {
    const parsed = messageDuplicateJobSchema.safeParse(job.data);
    if (!parsed.success || job.id !== parsed.data.idempotencyKey) {
      throw new UnrecoverableError('Invalid message duplicate job');
    }
    const data = Object.freeze(parsed.data);
    const identity = {
      jobId: data.idempotencyKey,
      chatId: data.chatId,
      sourceCreatedAt: data.sourceCreatedAt,
    };
    // FLAG: Pressure, ordering and source readiness deferrals share an absolute lifetime.
    if (
      Date.now() - Date.parse(data.createdAt) >= 10 * 60_000 ||
      Date.parse(data.createdAt) > Date.now() + 60_000
    ) {
      await this.ordering.abandon(identity);
      return;
    }
    try {
      const result = await this.ordering.runInOrder(
        identity,
        data.actionEligible,
        (lease, eligible) =>
          this.execution.processMessageDuplicateJob(
            { ...data, actionEligible: data.actionEligible && eligible === true },
            lease,
          ),
      );
      if (result.kind !== 'defer') return;
    } catch (error) {
      if (
        !(error instanceof PhotoDuplicateSourceNotReadyError) &&
        !(error instanceof MessageDuplicateMediaDeferredError)
      ) {
        if (error instanceof UnrecoverableError || job.attemptsMade + 1 >= (job.opts.attempts ?? 1))
          await this.ordering.abandon(identity);
        throw error;
      }
    }
    try {
      if (!token) throw new Error('Missing message duplicate worker lock');
      await job.moveToDelayed(Date.now() + 5000, token);
    } catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await this.ordering.abandon(identity);
      throw error;
    }
    throw new DelayedError();
  }
}
