import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { buildUserAgreementStartNotice } from '../common/user-agreement-notice';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { SUPPORT_CHAT_URL } from '../moderation/private-control.constants';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from './publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { assertPublisherIdentityOrDelay } from './publisher-identity-attestation-job-guard';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  isFreshPublisherStart,
  PUBLISHER_START_QUEUE,
  PublisherStartQueueService,
  type PublisherStartJob,
} from './publisher-start.queue';

const PUBLISHER_HOME_START_PARAM = `mr-${Buffer.from(
  JSON.stringify({ v: 1, k: 'route', r: '/' }),
  'utf8',
).toString('base64url')}`;

export function buildPublisherStartText(appBaseUrl?: string | null): string {
  return [
    'Привет! Я Публик, помощник для публикаций в MAX от создателей [Майора Максимова](https://max.ru/id613070470872_9_bot).',
    'Помогаю создавать посты для чатов и каналов, публиковать их сразу или по расписанию и настраивать автопостинг из VK.',
    'Управление публикациями и подключёнными чатами и каналами доступно в мини-приложении.',
    buildUserAgreementStartNotice(appBaseUrl),
  ].join('\n\n');
}

@Processor(PUBLISHER_START_QUEUE, { concurrency: 2 })
export class PublisherStartProcessor extends WorkerHost {
  constructor(
    private readonly maxClient: MaxClientService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botLinks: MaxBotLinkService,
    private readonly config: ConfigService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly startQueue: PublisherStartQueueService,
  ) {
    super();
  }

  async process(job: Job<PublisherStartJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher greeting claimed outside api-publisher');
    }
    const { publisherBotId, privateChatId, requestedAt } = job.data;
    if (
      job.data.version !== 1 ||
      !job.id ||
      publisherBotId !== this.botRegistry.getPublisherBotDescriptor().id ||
      !isPrivateDirectChatId(privateChatId)
    )
      throw new UnrecoverableError('Invalid publisher greeting job');
    if (!isFreshPublisherStart(requestedAt)) return;
    if (job.data.dispatchStarted) return;
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
    const miniappUrl = this.botLinks.buildMiniappStartUrlSync(
      PUBLISHER_HOME_START_PARAM,
      publisherBotId,
    );
    let dispatchClaimed = false;
    try {
      await this.maxClient.sendMessageImmediateWithId(
        privateChatId,
        buildPublisherStartText(this.config.get<string>('APP_BASE_URL')),
        {
          textFormat: 'markdown',
          buttons: [
            ...(miniappUrl
              ? [[{ type: 'link' as const, text: 'Открыть Публик', url: miniappUrl }]]
              : []),
            [{ type: 'link', text: 'Поддержка', url: SUPPORT_CHAT_URL }],
          ],
          beforeSend: async () => {
            // FLAG: Persist before POST /messages. A stalled or ambiguous send must never replay.
            if (job.data.dispatchStarted)
              throw new UnrecoverableError('Publisher greeting already attempted');
            if (!isFreshPublisherStart(requestedAt))
              throw new UnrecoverableError('Publisher greeting expired');
            if (!(await this.startQueue.claimDispatch(job.id!)))
              throw new UnrecoverableError('Publisher greeting dispatch already claimed');
            dispatchClaimed = true;
            await job.updateData({ ...job.data, dispatchStarted: true });
          },
        },
        {
          botId: publisherBotId,
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_START,
          timeoutMs: 5_000,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
    } catch (error: unknown) {
      if (dispatchClaimed || job.data.dispatchStarted)
        throw new UnrecoverableError(
          'Publisher greeting dispatch claimed; automatic retry disabled',
        );
      throw error;
    }
  }
}
