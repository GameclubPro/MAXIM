import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { Job, Queue } from 'bullmq';
import {
  createPublicationVideoUploadSchema,
  publicationVideoUploadIdSchema,
  type CreatePublicationVideoUpload,
  type PublicationAsset,
  type PublicationVideoUploadStatus,
} from '@maxim/contracts/publication';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';

export const PUBLISHER_VIDEO_UPLOAD_QUEUE = 'publisher-video-upload';
export const PUBLISHER_VIDEO_UPLOAD_TTL_MS = 60 * 60_000;
export type PublisherVideoUploadJob = CreatePublicationVideoUpload & {
  actorUserId: string;
  publisherBotId: string;
  requestedAtMs: number;
  phase: 'create' | 'complete';
};
export type PublisherVideoUploadResult =
  | { kind: 'session'; url: string; token: string }
  | { kind: 'asset'; asset: PublicationAsset };

const UPLOAD_RATE_SCRIPT = `
for i, key in ipairs(KEYS) do
  if tonumber(redis.call('GET', key) or '0') >= tonumber(ARGV[i]) then return 0 end
end
for _, key in ipairs(KEYS) do
  if redis.call('INCR', key) == 1 then redis.call('EXPIRE', key, 60) end
end
return 1
`;

@Injectable()
export class PublisherVideoUploadQueueService {
  readonly publisherBotId: string;

  constructor(
    @InjectQueue(PUBLISHER_VIDEO_UPLOAD_QUEUE)
    private readonly queue: Queue<PublisherVideoUploadJob, PublisherVideoUploadResult>,
    config: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: config.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  jobId(actorUserId: string, uploadId: string, phase: 'create' | 'complete' = 'create'): string {
    const identity = createHash('sha256')
      .update(`${this.publisherBotId}\0${actorUserId}`)
      .digest('hex');
    return `publisher-video-${identity}-${uploadId}-${phase}`;
  }

  async create(actorUserId: string, body: unknown): Promise<PublicationVideoUploadStatus> {
    const parsed = createPublicationVideoUploadSchema.safeParse(body);
    if (!parsed.success)
      throw new BadRequestException('Неверные параметры видео. Максимум 100 МБ.');
    const input = parsed.data;
    const jobId = this.jobId(actorUserId, input.requestId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      if (
        existing.data.fileName !== input.fileName ||
        existing.data.sizeBytes !== input.sizeBytes ||
        existing.data.mimeType !== input.mimeType
      ) {
        throw new BadRequestException('Параметры загрузки изменились. Выберите видео снова.');
      }
      return this.status(actorUserId, input.requestId);
    }
    const counts = await this.queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'paused',
      'prioritized',
    );
    if (Object.values(counts).reduce((sum, count) => sum + count, 0) >= 100) {
      throw new HttpException('Загрузка видео временно занята. Повторите позже.', 429);
    }
    const client = await this.queue.client;
    const userHash = createHash('sha256').update(actorUserId).digest('hex');
    client.defineCommand('publisherVideoUploadAdmission', {
      numberOfKeys: 2,
      lua: UPLOAD_RATE_SCRIPT,
    });
    const admitted = await client.runCommand('publisherVideoUploadAdmission', [
      this.queue.toKey(`admission-${userHash}`),
      this.queue.toKey('admission-global'),
      3,
      30,
    ]);
    if (Number(admitted) !== 1)
      throw new HttpException('Слишком много загрузок видео. Повторите через минуту.', 429);
    await this.queue.add(
      'create',
      {
        ...input,
        actorUserId,
        publisherBotId: this.publisherBotId,
        requestedAtMs: Date.now(),
        phase: 'create',
      },
      this.options(jobId, 3),
    );
    return { status: 'PENDING', uploadId: input.requestId };
  }

  async complete(actorUserId: string, uploadId: string): Promise<PublicationVideoUploadStatus> {
    const source = await this.getOwnedSession(actorUserId, uploadId);
    if ((await source.getState()) !== 'completed' || source.returnvalue?.kind !== 'session') {
      throw new BadRequestException('Загрузка видео ещё не готова.');
    }
    await this.queue.add(
      'complete',
      { ...source.data, phase: 'complete' },
      this.options(this.jobId(actorUserId, uploadId, 'complete'), 60),
    );
    return this.status(actorUserId, uploadId);
  }

  async status(actorUserId: string, uploadId: string): Promise<PublicationVideoUploadStatus> {
    const source = await this.getOwnedSession(actorUserId, uploadId);
    const completion = await this.queue.getJob(this.jobId(actorUserId, uploadId, 'complete'));
    if (completion) {
      const state = await completion.getState();
      if (state === 'completed' && completion.returnvalue?.kind === 'asset') {
        return { status: 'READY', uploadId, asset: completion.returnvalue.asset };
      }
      return state === 'failed'
        ? { status: 'FAILED', uploadId, message: 'MAX не подтвердил видео. Выберите файл снова.' }
        : { status: 'PROCESSING', uploadId };
    }
    const state = await source.getState();
    if (state === 'failed')
      return {
        status: 'FAILED',
        uploadId,
        message: 'Не удалось начать загрузку видео. Повторите.',
      };
    if (state === 'completed' && source.returnvalue?.kind === 'session') {
      return {
        status: 'UPLOADING',
        uploadId,
        url: source.returnvalue.url,
        expiresAt: new Date(
          source.data.requestedAtMs + PUBLISHER_VIDEO_UPLOAD_TTL_MS,
        ).toISOString(),
      };
    }
    return { status: 'PENDING', uploadId };
  }

  async getOwnedSession(
    actorUserId: string,
    uploadId: string,
  ): Promise<Job<PublisherVideoUploadJob, PublisherVideoUploadResult>> {
    if (!publicationVideoUploadIdSchema.safeParse(uploadId).success)
      throw new NotFoundException('Загрузка видео недоступна.');
    const job = await this.queue.getJob(this.jobId(actorUserId, uploadId));
    if (
      !job ||
      job.data.actorUserId !== actorUserId ||
      job.data.publisherBotId !== this.publisherBotId ||
      Date.now() - job.data.requestedAtMs > PUBLISHER_VIDEO_UPLOAD_TTL_MS
    ) {
      throw new NotFoundException('Срок загрузки видео истёк. Выберите файл снова.');
    }
    return job;
  }

  private options(jobId: string, attempts: number) {
    return {
      jobId,
      attempts,
      backoff: { type: 'fixed', delay: 5000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 3600, count: 1000 },
    };
  }
}
