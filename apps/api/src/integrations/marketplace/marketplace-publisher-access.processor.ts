import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ForbiddenException } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../../runtime/app-role';
import { MarketplaceAccessService } from './marketplace-access.service';
import { MARKETPLACE_PILOT_USER_ID } from './marketplace-state.service';
import {
  MARKETPLACE_PUBLISHER_ACCESS_QUEUE,
  marketplacePublisherAccessJobSchema,
  type MarketplacePublisherAccessJob,
  type MarketplacePublisherAccessResult,
} from './marketplace-publisher-access.queue';

@Processor(MARKETPLACE_PUBLISHER_ACCESS_QUEUE, { concurrency: 2 })
export class MarketplacePublisherAccessProcessor extends WorkerHost {
  constructor(private readonly access: MarketplaceAccessService) {
    super();
  }
  async process(
    job: Job<MarketplacePublisherAccessJob>,
  ): Promise<MarketplacePublisherAccessResult> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher')
      throw new UnrecoverableError('Marketplace access claimed outside Publisher');
    const parsed = marketplacePublisherAccessJobSchema.safeParse(job.data);
    if (
      !parsed.success ||
      (!parsed.data.exchangeV2 &&
        !parsed.data.scope &&
        parsed.data.actorUserId !== MARKETPLACE_PILOT_USER_ID)
    )
      throw new UnrecoverableError('Invalid marketplace access request');
    const { requestedAtMs, exchangeV2, background, scope, ...input } = parsed.data;
    if (Date.now() - requestedAtMs > 8000 || requestedAtMs > Date.now() + 1000)
      return { state: 'RETRY' };
    try {
      // FLAG: Editorial/button proof has no statistics grant; exact scope cannot admit legacy jobs.
      const binding = await (scope
        ? this.access.attest(input, false, background === true, scope)
        : background
          ? this.access.attest(input, exchangeV2 === true, true)
          : exchangeV2
            ? this.access.attest(input, true)
            : this.access.attest(input));
      return { state: 'ACTIVE', bindingId: binding.id };
    } catch (error) {
      // Queue payloads and error storage never include MAX responses or credentials.
      return { state: error instanceof ForbiddenException ? 'DENIED' : 'RETRY' };
    }
  }
}
