import { InjectQueue } from '@nestjs/bullmq';
import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { QueueEvents, type Queue } from 'bullmq';
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

@Injectable()
export class MarketplacePublisherAccessQueueService implements OnModuleDestroy {
  private events: QueueEvents | null = null;
  constructor(
    @InjectQueue(MARKETPLACE_PUBLISHER_ACCESS_QUEUE)
    private readonly queue: Queue<MarketplacePublisherAccessJob, MarketplacePublisherAccessResult>,
  ) {}
  async onModuleDestroy(): Promise<void> {
    await this.events?.close();
  }

  async attest(input: MarketplaceBindingInput): Promise<string> {
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
    this.events ??= new QueueEvents(this.queue.name, {
      connection: this.queue.opts.connection,
      prefix: this.queue.opts.prefix,
    });
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
        await job.waitUntilFinished(this.events, 8000),
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'MARKETPLACE_ACCESS_PENDING',
        message: 'Проверяем права в Публике. Обновите состояние через несколько секунд.',
      });
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
