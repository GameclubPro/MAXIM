import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { MaxUpdate } from '@maxim/contracts';
import { z } from 'zod';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { resolveTrustedDuplicateStateRevision } from '../duplicate-message-revision';
import { classifyDuplicateEventTime } from '../duplicate-enforcement-safety';
import { RedisCounterService } from '../redis-counter.service';
import { PhotoDuplicateAnalysisService } from '../photo-duplicate/photo-duplicate-analysis.service';
import { SecurePhotoDownloader } from '../photo-duplicate/secure-photo-downloader';
import type { PhotoDuplicateOrderingLease } from '../photo-duplicate/photo-duplicate-ordering.store';
import { PhotoDuplicateSourceNotReadyError } from '../photo-duplicate/photo-duplicate.queue';
import { isPendingWebhookTimeoutQuarantineMessage } from '../../webhook/webhook-timeout-quarantine';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import {
  digestDuplicateContent,
  extractDuplicateMessageContent,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
} from './message-duplicate-state';
import type { MessageDuplicateJob } from './message-duplicate.queue';
import type { ExecuteDuplicateModerationAction } from '../duplicate-moderation.actions';
import { PhotoDuplicateRuntimePolicyService } from '../photo-duplicate/photo-duplicate-runtime-policy.service';

const requireFromHere = createRequire(__filename);
const pointerSchema = z
  .object({
    webhookEventId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(512),
    eventTimestampMs: z.number().int().positive(),
  })
  .strict();
const hashSchema = z
  .object({
    version: z.literal(MESSAGE_DUPLICATE_MEDIA_VERSION),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class MessageDuplicateMediaDeferredError extends Error {}

@Injectable()
export class MessageDuplicateMediaService {
  private readonly logger = new Logger(MessageDuplicateMediaService.name);
  private readonly binary: SecurePhotoDownloader;
  private readonly resourceKey: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisCounterService,
    private readonly photos: PhotoDuplicateAnalysisService,
    private readonly policy: MessageDuplicatePolicyService,
    private readonly history: MessageDuplicateHistoryService,
    private readonly enforcement: MessageDuplicateEnforcementService,
    private readonly bots: MaxBotLinkService,
    private readonly governor: BackgroundRuntimeGovernorService,
    config: ConfigService,
    private readonly photoPolicy: PhotoDuplicateRuntimePolicyService,
  ) {
    const maxBytes = config.get<number>('MESSAGE_DUPLICATE_MAX_BYTES') ?? 8_388_608;
    this.binary = new SecurePhotoDownloader(
      new ConfigService({
        PHOTO_DUPLICATE_ALLOWED_HOSTS:
          config.get('MESSAGE_DUPLICATE_ALLOWED_HOSTS') ?? 'i.oneme.ru,fd.oneme.ru,*.okcdn.ru',
        PHOTO_DUPLICATE_MAX_BYTES: maxBytes,
        PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: 5000,
      }),
    );
    this.resourceKey = digestDuplicateContent([
      MESSAGE_DUPLICATE_MEDIA_VERSION,
      maxBytes,
      config.get('PHOTO_DUPLICATE_MAX_BYTES'),
      config.get('PHOTO_DUPLICATE_MAX_PIXELS'),
    ]);
  }

  async process(
    job: MessageDuplicateJob,
    lease: PhotoDuplicateOrderingLease,
    executeFullAction?: ExecuteDuplicateModerationAction,
  ): Promise<void> {
    const policy = await this.policy.resolve(job.chatId, true);
    if (
      policy.mode === 'off' ||
      policy.revision !== job.controlRevision ||
      job.eventTimestampMs < policy.effectiveAtMs
    )
      return;
    lease.assertOwned();
    const source = await this.loadSource(job.webhookEventId);
    if (!source) return;
    const message = source.update.message!;
    if (
      message.chatId !== job.chatId ||
      message.messageId !== job.messageId ||
      source.eventTimestampMs !== job.eventTimestampMs ||
      this.bots.isKnownBotUserId(message.senderId)
    )
      return;
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: job.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            admins: { select: { userId: true } },
            rules: { select: { publishedUrl: true, publishedMessageId: true } },
          },
        },
      },
    });
    if (
      !settings?.antiDuplicateEnabled ||
      settings.duplicateCompareMode === 'TEXT' ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.some((admin) => admin.userId === message.senderId) ||
      messageDuplicateSettingsDigest(settings) !== job.settingsDigest
    )
      return;
    const flow = resolveDuplicateFlowConfig(settings);
    if (
      classifyDuplicateEventTime({
        eventTimestampMs: job.eventTimestampMs,
        windowSec: flow.windowSec,
      })
    )
      return;
    const content = extractDuplicateMessageContent(source.update.raw);
    if (!content.complete || content.media.length === 0) return;
    const scope = digestDuplicateContent([
      job.chatId,
      message.senderId,
      job.controlRevision,
      job.settingsDigest,
    ]);
    const candidateKeys = this.history
      .candidateKeys(content, settings)
      .map((key) => `message-duplicate:candidate:v1:${scope}:${key}`);
    const ownPointer = {
      webhookEventId: job.webhookEventId,
      messageId: job.messageId,
      eventTimestampMs: job.eventTimestampMs,
    };
    let previous: z.infer<typeof pointerSchema> | null = null;
    for (const key of candidateKeys) {
      const raw = await this.redis.getString(key);
      if (raw && raw.length < 2048) {
        const parsed = pointerSchema.safeParse(safeJson(raw));
        if (
          parsed.success &&
          (parsed.data.eventTimestampMs < job.eventTimestampMs ||
            (parsed.data.eventTimestampMs === job.eventTimestampMs &&
              parsed.data.messageId !== job.messageId)) &&
          job.eventTimestampMs - parsed.data.eventTimestampMs < flow.windowSec * 1000
        )
          previous ??= parsed.data;
        if (!parsed.success) {
          lease.assertOwned();
          await this.redis.setStringWithTtl(key, JSON.stringify(ownPointer), flow.windowSec);
        }
      }
      lease.assertOwned();
    }
    const currentCached = await this.readHashes(content, source.update);
    if (!previous && currentCached.some((hash) => hash === null)) {
      for (const key of candidateKeys) {
        lease.assertOwned();
        await this.redis.setStringIfAbsentWithTtl(key, JSON.stringify(ownPointer), flow.windowSec);
      }
      return;
    }
    const decision = await this.governor.decide({
      component: 'message-duplicate-media',
      sourceTag: 'message-duplicate',
    });
    if (decision.action === 'pause')
      throw new MessageDuplicateMediaDeferredError('Message duplicate media deferred by pressure');
    const deadlineAtMs = Date.now() + 30_000;
    if (previous) {
      try {
        const baseline = await this.loadSource(previous.webhookEventId);
        const baselineMessage = baseline?.update.message;
        if (
          baseline &&
          baselineMessage &&
          baselineMessage.chatId === job.chatId &&
          baselineMessage.senderId === message.senderId &&
          baselineMessage.messageId === previous.messageId &&
          baseline.eventTimestampMs === previous.eventTimestampMs
        ) {
          const baselineContent = extractDuplicateMessageContent(baseline.update.raw);
          if (
            baselineContent.complete &&
            this.history
              .candidateKeys(baselineContent, settings)
              .some((key) =>
                candidateKeys.includes(`message-duplicate:candidate:v1:${scope}:${key}`),
              )
          ) {
            const hashes = await this.hashMedia(
              baselineContent,
              baseline.update,
              flow.windowSec,
              deadlineAtMs,
            );
            lease.assertOwned();
            await this.history.observe({
              content: baselineContent,
              chatId: job.chatId,
              userId: message.senderId,
              messageId: baselineMessage.messageId,
              eventTimestampMs: baseline.eventTimestampMs,
              controlRevision: policy.revision,
              settings,
              mediaHashes: hashes,
            });
          }
        }
      } catch {
        this.logger.debug(
          { chatId: job.chatId },
          'Message duplicate baseline media could not be verified',
        );
      }
    }
    lease.assertOwned();
    const hashes = await this.hashMedia(content, source.update, flow.windowSec, deadlineAtMs);
    if (Date.now() >= deadlineAtMs) throw new Error('Message media verification deadline exceeded');
    lease.assertOwned();
    const result = await this.history.observe({
      content,
      chatId: job.chatId,
      userId: message.senderId,
      messageId: job.messageId,
      eventTimestampMs: job.eventTimestampMs,
      controlRevision: policy.revision,
      settings,
      mediaHashes: hashes,
    });
    for (const key of candidateKeys) {
      lease.assertOwned();
      await this.redis.setStringWithTtl(key, JSON.stringify(ownPointer), flow.windowSec);
    }
    // Existing photo-only policy owns its subset, including its established sanction settings.
    const photoOwned =
      source.update.type === 'message_created' &&
      settings.duplicatePhotoEnabled &&
      content.media.every((media) => media.kind === 'photo') &&
      (
        await this.photoPolicy.resolveEffectivePolicy({
          chatId: job.chatId,
          preset: settings.duplicatePhotoMatchPreset,
          scope: settings.duplicatePhotoScope,
        })
      ).enforce;
    if (
      result &&
      !photoOwned &&
      job.actionEligible === true &&
      (await lease.resolveActionEligibility())
    ) {
      await this.enforcement.enqueue({
        ...result,
        chatId: job.chatId,
        botId: source.botId,
        sourceCreatedAt: message.createdAt,
        text: content.text,
        settings,
        update: source.update,
        executeFullAction: executeFullAction
          ? (request) =>
              executeFullAction({
                ...request,
                rulesPublishedUrl: settings.chat.rules?.publishedUrl ?? null,
                rulesPublishedMessageId: settings.chat.rules?.publishedMessageId ?? null,
              })
          : undefined,
        assertLease: lease.assertOwned,
      });
    }
  }

  private async loadSource(webhookEventId: string) {
    const row = await this.prisma.webhookEvent.findUnique({
      where: { id: webhookEventId },
      select: {
        status: true,
        botId: true,
        normalizedPayload: true,
        nextEnqueueAt: true,
        errorMessage: true,
      },
    });
    if (
      !row ||
      row.status === 'DUPLICATE' ||
      (row.status === 'FAILED' &&
        row.nextEnqueueAt === null &&
        !isPendingWebhookTimeoutQuarantineMessage(row.errorMessage))
    )
      return null;
    if (row.status !== 'PROCESSED') throw new PhotoDuplicateSourceNotReadyError(webhookEventId);
    const update = row.normalizedPayload as unknown as MaxUpdate;
    if (!update.message) return null;
    const revision = resolveTrustedDuplicateStateRevision(
      update.type,
      update.message.createdAt,
      update.eventTimestampSource,
    );
    if (!revision.duplicateStateEventTimestampMs) return null;
    const botId = row.botId ?? update.botId ?? this.bots.getDefaultBotId();
    if (!botId) return null;
    return { update, botId, eventTimestampMs: revision.duplicateStateEventTimestampMs };
  }

  private cacheKey(identity: string, update: MaxUpdate): string {
    // FLAG: Binary proofs are message/revision scoped; an unverified platform id cannot reuse
    // another message's bytes. Photos additionally reuse the separately validated photo cache.
    const source = digestDuplicateContent([
      update.message?.chatId,
      update.message?.messageId,
      update.message?.createdAt,
      identity,
    ]);
    return `message-duplicate:media-hash:v1:${this.resourceKey}:${source}`;
  }

  private async readHashes(
    content: DuplicateMessageContent,
    update: MaxUpdate,
  ): Promise<Array<string | null>> {
    const results: Array<string | null> = [];
    for (const media of content.media) {
      const raw = await this.redis.getString(this.cacheKey(media.identity, update));
      const parsed = raw && raw.length < 512 ? hashSchema.safeParse(safeJson(raw)) : null;
      results.push(parsed?.success ? parsed.data.hash : null);
    }
    return results;
  }

  private async hashMedia(
    content: DuplicateMessageContent,
    update: MaxUpdate,
    ttl: number,
    deadlineAtMs: number,
  ): Promise<string[]> {
    const hashes = await this.readHashes(content, update);
    const photoIndexes = content.media
      .map((media, index) => (media.kind === 'photo' && !hashes[index] ? index : -1))
      .filter((index) => index >= 0);
    if (photoIndexes.some((index) => !hashes[index])) {
      const message = update.message!;
      const result = await this.photos.fingerprintAlbum(
        {
          chatId: message.chatId,
          messageId: message.messageId,
          senderId: message.senderId,
          createdAtMs: Date.parse(message.createdAt),
          caption: content.text,
          images: photoIndexes.map((index) => ({
            source: 'direct' as const,
            photoId: content.media[index]!.photoId,
            downloadUrl: content.media[index]!.url,
          })),
        },
        ttl,
        deadlineAtMs,
      );
      if (result.kind !== 'complete') throw new Error('Photo message content remains unverified');
      photoIndexes.forEach((index, position) => {
        hashes[index] = result.fingerprint.images[position]!.canonicalHash;
      });
    }
    for (let index = 0; index < content.media.length; index += 1) {
      if (Date.now() >= deadlineAtMs)
        throw new Error('Message media verification deadline exceeded');
      const media = content.media[index]!;
      if (!hashes[index]) {
        if (!media.url) throw new Error('Message media download URL unavailable');
        const downloaded = await this.binary.downloadBinary(media.url, { deadlineAtMs });
        await this.verifyBinary(downloaded.bytes, media.kind);
        hashes[index] = createHash('sha256').update(downloaded.bytes).digest('hex');
      }
      await this.redis.setStringWithTtl(
        this.cacheKey(media.identity, update),
        JSON.stringify({ version: MESSAGE_DUPLICATE_MEDIA_VERSION, hash: hashes[index] }),
        ttl,
      );
    }
    return hashes as string[];
  }

  protected async verifyBinary(bytes: Buffer, kind: string): Promise<void> {
    const runtime = requireFromHere('file-type/core') as {
      fileTypeFromBuffer(bytes: Uint8Array): Promise<{ mime: string; ext: string } | undefined>;
    };
    const format = await runtime.fileTypeFromBuffer(bytes);
    if (
      !format ||
      (kind === 'video' && !format.mime.startsWith('video/')) ||
      (kind === 'audio' && !format.mime.startsWith('audio/') && format.ext !== 'mp4')
    ) {
      throw new Error('Message media format could not be verified');
    }
  }
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
