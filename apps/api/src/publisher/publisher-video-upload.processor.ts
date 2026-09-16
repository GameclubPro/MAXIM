import { Processor, WorkerHost } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from '../admin/publication-video-media';
import {
  PUBLISHER_VIDEO_UPLOAD_QUEUE,
  PUBLISHER_VIDEO_UPLOAD_TTL_MS,
  PublisherVideoUploadQueueService,
  type PublisherVideoUploadJob,
  type PublisherVideoUploadResult,
} from './publisher-video-upload.queue';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';

@Processor(PUBLISHER_VIDEO_UPLOAD_QUEUE, { concurrency: 2 })
export class PublisherVideoUploadProcessor extends WorkerHost {
  constructor(
    private readonly uploads: PublisherVideoUploadQueueService,
    private readonly maxClient: MaxClientService,
    private readonly prisma: PrismaService,
    private readonly boundary: PublisherRuntimeBoundaryService,
    private readonly health: PublisherDispatchHealthService,
  ) {
    super();
  }

  async process(job: Job<PublisherVideoUploadJob>): Promise<PublisherVideoUploadResult> {
    const data = job.data;
    if (
      !roleRunsPublisher(getAppRole()) ||
      process.env.APP_SERVICE_NAME !== 'api-publisher' ||
      data.publisherBotId !== this.uploads.publisherBotId
    ) {
      throw new UnrecoverableError('Publisher video upload claimed outside its owner');
    }
    if (Date.now() - data.requestedAtMs > PUBLISHER_VIDEO_UPLOAD_TTL_MS) {
      throw new UnrecoverableError('Publisher video upload expired');
    }
    this.boundary.assertDispatchEnabled();
    await this.health.assertDispatchAllowed();
    const options = {
      botId: data.publisherBotId,
      trafficClass: 'interactive' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      timeoutMs: 15_000,
    };
    try {
      if (data.phase === 'create') {
        const session = await this.maxClient.createVideoUploadSession(options);
        return { kind: 'session', ...session };
      }
      const source = await this.uploads.getOwnedSession(data.actorUserId, data.requestId);
      if (source.returnvalue?.kind !== 'session') throw new Error('Upload session unavailable');
      const token = source.returnvalue.token;
      if (!(await this.maxClient.getVideoDownloadUrl(token, options))) {
        throw new Error('Video is still processing');
      }
      const sha256 = createHash('sha256')
        .update(`publisher-video:${data.publisherBotId}\0${token}`)
        .digest('hex');
      const asset = await this.prisma.publicationAsset.upsert({
        where: { actorUserId_sha256: { actorUserId: data.actorUserId, sha256 } },
        create: {
          actorUserId: data.actorUserId,
          sha256,
          mimeType: data.mimeType,
          fileName: data.fileName,
          sizeBytes: data.sizeBytes,
          bytes: null,
          durablePayload: {
            [PUBLICATION_UPLOADED_VIDEO_FIELD]: { version: 1, botId: data.publisherBotId, token },
          },
        },
        update: {},
        select: { id: true, mimeType: true, fileName: true, sizeBytes: true },
      });
      return { kind: 'asset', asset: { ...asset, type: 'video' } };
    } catch {
      // FLAG: Signed upload URLs and media tokens must not enter BullMQ failure logs.
      throw new Error('MAX video preparation is not ready');
    }
  }
}
