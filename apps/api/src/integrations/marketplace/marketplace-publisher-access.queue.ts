import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueueEvents, type Queue } from 'bullmq';
import type Redis from 'ioredis';
import { z } from 'zod';
import {
  marketplaceBindingInputSchema,
  type MarketplaceBindingInput,
} from '@maxim/contracts/marketplace-integration';

export const MARKETPLACE_PUBLISHER_ACCESS_QUEUE = 'marketplace-publisher-access';
export const marketplacePublisherAccessJobSchema = marketplaceBindingInputSchema
  .extend({
    profile: z.literal('publisher'),
    requestedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type MarketplacePublisherAccessJob = z.infer<typeof marketplacePublisherAccessJobSchema>;
export const marketplacePublisherAccessResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ACTIVE'), bindingId: z.string().uuid() }).strict(),
  z.object({ state: z.literal('DENIED') }).strict(),
  z.object({ state: z.literal('RETRY') }).strict(),
]);
export type MarketplacePublisherAccessResult = z.infer<
  typeof marketplacePublisherAccessResultSchema
>;
const eventTailSchema = z
  .array(z.tuple([z.string().regex(/^\d{1,20}-\d{1,20}$/), z.array(z.string())]))
  .max(1);

@Injectable()
export class MarketplacePublisherAccessQueueService implements OnModuleDestroy {
  private events: QueueEvents | null = null;
  private eventsInitialization: Promise<QueueEvents> | null = null;
  private closing = false;
  constructor(
    @InjectQueue(MARKETPLACE_PUBLISHER_ACCESS_QUEUE)
    private readonly queue: Queue<MarketplacePublisherAccessJob, MarketplacePublisherAccessResult>,
  ) {}
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    const events = this.events;
    this.events = null;
    await events?.close();
  }

  private pendingAccess(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'MARKETPLACE_ACCESS_PENDING',
      message: 'Проверяем права в Публике. Обновите состояние через несколько секунд.',
    });
  }

  private async initializeEvents(): Promise<QueueEvents> {
    const client = (await this.queue.client) as unknown as Pick<Redis, 'xrevrange'>;
    if (this.closing) throw new Error('Marketplace access queue is closing');
    // FLAG: BullMQ connection readiness precedes its first XREAD. Capture only
    // the stream tail before enqueue so a reply in that startup gap is retained.
    const tail = eventTailSchema.parse(
      await client.xrevrange(this.queue.toKey('events'), '+', '-', 'COUNT', 1),
    );
    // FLAG: Destroy never permits an initializer to create a late connection.
    // The injected queue owns the pending read and closes its producer client.
    if (this.closing) throw new Error('Marketplace access queue is closing');
    const events = new QueueEvents(this.queue.name, {
      connection: this.queue.opts.connection,
      prefix: this.queue.opts.prefix,
      lastEventId: tail[0]?.[0] ?? '0-0',
    });
    this.events = events;
    return events;
  }

  private async getEvents(): Promise<QueueEvents> {
    if (this.closing) throw new Error('Marketplace access queue is closing');
    if (this.events) return this.events;
    const pending = (this.eventsInitialization ??= this.initializeEvents());
    try {
      return await pending;
    } finally {
      if (this.eventsInitialization === pending) this.eventsInitialization = null;
    }
  }

  async attest(input: MarketplaceBindingInput): Promise<string> {
    if (this.closing) throw this.pendingAccess();
    const data = marketplacePublisherAccessJobSchema.parse({ ...input, requestedAtMs: Date.now() });
    const pending = await this.queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'prioritized',
      'paused',
    );
    if (Object.values(pending).reduce((sum, value) => sum + value, 0) >= 100)
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_ACCESS_PENDING',
        message: 'Проверяем подключение Публика. Повторите через несколько секунд.',
      });
    let events: QueueEvents;
    try {
      events = await this.getEvents();
      if (this.closing) throw new Error('Marketplace access queue is closing');
    } catch {
      throw this.pendingAccess();
    }
    const identity = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const job = await this.queue.add('attest', data, {
      jobId: `marketplace-access-${identity}-${Math.floor(data.requestedAtMs / 5000)}`,
      attempts: 1,
      removeOnComplete: { age: 30, count: 100 },
      removeOnFail: { age: 30, count: 100 },
    });
    let result: MarketplacePublisherAccessResult;
    try {
      result = marketplacePublisherAccessResultSchema.parse(
        await job.waitUntilFinished(events, 8000),
      );
    } catch {
      throw this.pendingAccess();
    }
    if (result.state === 'DENIED')
      throw new ForbiddenException('Нужны действующие права администратора пользователя и Публика');
    if (result.state !== 'ACTIVE')
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_ACCESS_PENDING',
        message: 'Проверка прав Публика ещё не завершена. Повторите через несколько секунд.',
      });
    return result.bindingId;
  }
}
