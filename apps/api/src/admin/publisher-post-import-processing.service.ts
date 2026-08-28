import type { PublicationContentInput, PublicationMediaInput } from '@maxim/contracts/publication';
import type {
  PublisherPostImportFailureCode,
  PublisherPostImportOmission,
} from '@maxim/contracts/publisher';
import { maxUpdateSchema } from '@maxim/contracts';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  extractIncomingMessageMarkup,
  renderIncomingMarkupAsMarkdown,
} from '../moderation/private-control-markup-importer';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import {
  MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES,
  MaxImageUploadNormalizationError,
  normalizeUnsupportedMaxImageUpload,
} from '../max/max-image-upload-normalization';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import {
  PublicationAudienceMode,
  PublicationAudienceSelection,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublisherPostImportStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  PUBLISHER_POST_IMPORT_RESULT_TTL_MS,
  PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS,
} from '../publisher/publisher-post-import.service';
import { PublicationContentService } from './publication-content.service';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import { PUBLICATION_MAX_VIDEO_BYTES } from './publication-video-media';

const POST_IMPORT_LEASE_MS = 2 * 60_000;
const POST_IMPORT_MAX_IMAGES = 10;
const POST_IMPORT_MAX_TEXT_LENGTH = 4_000;
const POST_IMPORT_FETCH_TIMEOUT_MS = 20_000;
const POST_IMPORT_ALLOWED_MEDIA_HOSTS = ['max.ru', 'oneme.ru', 'mycdn.me', 'okcdn.ru'] as const;

type ProcessResult = 'ready' | 'failed' | 'noop';
type PublisherPostImportSnapshotSource = 'webhook_receipt' | 'remote_exact';
type PublisherPostImportRejectionKind =
  | PublisherPostImportFailureCode
  | 'content_validation'
  | 'image_decode_budget_exceeded'
  | 'image_dimensions_exceeded'
  | 'image_format_unsupported_after_normalization'
  | 'image_invalid_payload'
  | 'image_normalization_dimensions_exceeded'
  | 'image_normalization_input_pixel_limit_exceeded'
  | 'image_normalization_output_too_large'
  | 'image_transcode_failed'
  | 'receipt_bot_mismatch'
  | 'receipt_identity_missing'
  | 'receipt_normalized_identity_mismatch'
  | 'receipt_payload_invalid'
  | 'receipt_raw_identity_mismatch';

class PublisherPostImportTerminalError extends Error {
  constructor(
    readonly code: PublisherPostImportFailureCode,
    message: string,
    readonly rejectionKind: PublisherPostImportRejectionKind = code,
  ) {
    super(message);
    this.name = 'PublisherPostImportTerminalError';
  }
}

class PublisherPostImportTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublisherPostImportTransientError';
  }
}

class PublisherPostImportSupersededError extends Error {}

@Injectable()
export class PublisherPostImportProcessingService {
  private readonly logger = new Logger(PublisherPostImportProcessingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly publicationContentService: PublicationContentService,
  ) {}

  async process(sessionId: string): Promise<ProcessResult> {
    const now = new Date();
    const lockToken = randomUUID();
    const claimed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(now.getTime() - POST_IMPORT_LEASE_MS) } },
        ],
      },
      data: { lockedAt: now, lockToken },
    });
    if (claimed.count === 0) {
      return 'noop';
    }

    const session = await this.prisma.publisherPostImportSession.findFirst({
      where: { id: sessionId, status: PublisherPostImportStatus.PROCESSING, lockToken },
    });
    if (!session) {
      return 'noop';
    }
    let snapshotSource: PublisherPostImportSnapshotSource = 'remote_exact';

    try {
      if (session.expiresAt <= now) {
        throw new PublisherPostImportTerminalError(
          'processing_timeout',
          'Publisher post import processing deadline expired',
        );
      }
      const privateChatId = session.privateChatId?.trim() ?? '';
      const incomingMessageId = session.incomingMessageId?.trim() ?? '';
      if (!privateChatId || !incomingMessageId) {
        throw new PublisherPostImportTerminalError(
          'message_unavailable',
          'Exact forwarded message identity is unavailable',
        );
      }
      let exactMessage: Record<string, unknown> | null = null;
      if (session.sourceWebhookEventId?.trim()) {
        snapshotSource = 'webhook_receipt';
        exactMessage = await this.loadPersistedForwardReceipt({
          sourceWebhookEventId: session.sourceWebhookEventId,
          publisherBotId: session.publisherBotId,
          actorUserId: session.actorUserId,
          privateChatId,
          incomingMessageId,
        });
      }
      if (!exactMessage) {
        snapshotSource = 'remote_exact';
        exactMessage = await this.loadRemoteIncomingMessage(
          privateChatId,
          incomingMessageId,
          session.publisherBotId,
        );
      }
      this.assertExactSender(exactMessage, session.actorUserId);
      const linkedMessage = this.extractLinkedForward(exactMessage);
      if (!linkedMessage) {
        throw new PublisherPostImportTerminalError(
          'invalid_forward',
          'Exact message is not a MAX forward',
        );
      }

      const content = await this.buildContent(linkedMessage, session.publisherBotId);
      const prepared = await this.publicationContentService.prepareContentRevision(content);
      await this.publicationContentService.assertPublisherCompatibleContent(
        prepared,
        session.actorUserId,
      );
      const publicationId = await this.prisma.$transaction(async (tx: any) => {
        const publicationRequestId = `post-import-${session.id}`;
        const publication = await tx.publication.create({
          data: {
            actorUserId: session.actorUserId,
            requestId: publicationRequestId,
            title: '',
            lifecycle: PublicationLifecycle.DRAFT,
            audienceSelection: PublicationAudienceSelection.SELECTED,
            audienceMode: PublicationAudienceMode.SNAPSHOT,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId: session.publisherBotId,
          },
          select: { id: true },
        });
        const revision = await this.publicationContentService.persistPreparedContentRevision(
          tx,
          publication.id,
          1,
          prepared,
          session.actorUserId,
        );
        await tx.publication.update({
          where: { id: publication.id },
          data: { canonicalContentRevisionId: revision.id },
        });
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: session.actorUserId,
            requestId: publicationRequestId,
            requestHash: createHash('sha256')
              .update(
                JSON.stringify({
                  kind: 'publisher_post_import',
                  sessionId: session.id,
                  incomingMessageId: session.incomingMessageId,
                }),
              )
              .digest('hex'),
            publicationId: publication.id,
            resultingVersion: 1,
          },
        });
        const completed = await tx.publisherPostImportSession.updateMany({
          where: {
            id: session.id,
            status: PublisherPostImportStatus.PROCESSING,
            lockToken,
          },
          data: {
            status: PublisherPostImportStatus.READY,
            publicationId: publication.id,
            failureCode: null,
            omissions: content.omissions,
            notificationKind: 'ready',
            notificationPending: true,
            notificationLockedAt: null,
            notificationLockToken: null,
            notificationDispatchStartedAt: null,
            captureGuardUntil: new Date(Date.now() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
            lockedAt: null,
            lockToken: null,
            expiresAt: new Date(Date.now() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
          },
        });
        if (completed.count !== 1) {
          throw new PublisherPostImportSupersededError();
        }
        return publication.id as string;
      });
      this.logger.log(
        { sessionId, publicationId, snapshotSource },
        'Publisher forwarded post import completed',
      );
      return 'ready';
    } catch (error: unknown) {
      if (error instanceof PublisherPostImportSupersededError) {
        return 'noop';
      }
      if (error instanceof PublisherPostImportTerminalError) {
        if (await this.fail(session.id, lockToken, error.code)) {
          this.logTerminalFailure(session.id, error.code, error.rejectionKind, snapshotSource);
        }
        return 'failed';
      }
      if (error instanceof BadRequestException) {
        if (await this.fail(session.id, lockToken, 'unsupported_content')) {
          this.logTerminalFailure(
            session.id,
            'unsupported_content',
            'content_validation',
            snapshotSource,
          );
        }
        return 'failed';
      }
      await this.prisma.publisherPostImportSession.updateMany({
        where: {
          id: session.id,
          status: PublisherPostImportStatus.PROCESSING,
          lockToken,
        },
        data: { lockedAt: null, lockToken: null },
      });
      throw error;
    }
  }

  async failInternalAfterFinalAttempt(sessionId: string): Promise<boolean> {
    const now = new Date();
    const failed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        lockedAt: null,
        lockToken: null,
      },
      data: {
        status: PublisherPostImportStatus.FAILED,
        failureCode: 'internal_error',
        notificationKind: 'failed',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        captureGuardUntil: new Date(now.getTime() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
        expiresAt: new Date(now.getTime() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
      },
    });
    return failed.count > 0;
  }

  private async buildContent(
    linkedMessage: Record<string, unknown>,
    publisherBotId: string,
  ): Promise<PublicationContentInput & { omissions: PublisherPostImportOmission[] }> {
    const sourceText = this.extractText(linkedMessage);
    if (sourceText.length > POST_IMPORT_MAX_TEXT_LENGTH) {
      throw new PublisherPostImportTerminalError('text_too_long', 'Forwarded text is too long');
    }
    const markup = extractIncomingMessageMarkup(linkedMessage);
    let rendered = markup.length > 0 ? renderIncomingMarkupAsMarkdown(sourceText, markup) : null;
    const omissions: PublisherPostImportOmission[] = [];
    if (markup.length > 0 && rendered === null) {
      omissions.push('formatting_not_preserved');
    }
    if (rendered && rendered.length > POST_IMPORT_MAX_TEXT_LENGTH) {
      rendered = null;
      omissions.push('formatting_not_preserved');
    }

    const rawAttachments = this.extractAttachments(linkedMessage);
    if (rawAttachments.some((item) => this.readAttachmentType(item) === 'inline_keyboard')) {
      omissions.push('buttons_not_imported');
    }
    const shareAttachments = rawAttachments.filter(
      (item) => this.readAttachmentType(item) === 'share',
    );
    const attachments = rawAttachments.filter((item) => {
      const type = this.readAttachmentType(item);
      return type !== 'inline_keyboard' && type !== 'share';
    });
    const types = attachments.map((item) => this.readAttachmentType(item));
    if (types.some((type) => type !== 'image' && type !== 'photo' && type !== 'video')) {
      omissions.push('attachments_not_imported');
    }
    const transferableAttachments = attachments.filter((item) => {
      const type = this.readAttachmentType(item);
      return type === 'image' || type === 'photo' || type === 'video';
    });
    const imageAttachments = transferableAttachments.filter((item) => {
      const type = this.readAttachmentType(item);
      return type === 'image' || type === 'photo';
    });
    const videoAttachments = transferableAttachments.filter(
      (item) => this.readAttachmentType(item) === 'video',
    );
    if (imageAttachments.length > POST_IMPORT_MAX_IMAGES) {
      throw new PublisherPostImportTerminalError('too_many_images', 'Forward has too many images');
    }
    if (
      videoAttachments.length > 1 ||
      (videoAttachments.length > 0 && imageAttachments.length > 0)
    ) {
      throw new PublisherPostImportTerminalError(
        'unsupported_content',
        'Mixed media forwards are not supported',
      );
    }

    const media: PublicationMediaInput[] = [];
    if (imageAttachments.length > 0) {
      const downloadedImages = await this.mapWithConcurrency(
        imageAttachments,
        3,
        async (attachment) => {
          const url = this.extractAttachmentUrl(attachment, 'image');
          if (!url) {
            throw new PublisherPostImportTerminalError(
              'media_download_failed',
              'Forwarded image has no durable download URL',
            );
          }
          const downloaded = await this.downloadMedia(url, PUBLICATION_MAX_IMAGE_BYTES, 'image');
          return this.prepareImportedImage(downloaded);
        },
      );
      const totalBytes = downloadedImages.reduce(
        (total, downloaded) => total + downloaded.bytes.length,
        0,
      );
      if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
        throw new PublisherPostImportTerminalError(
          'media_too_large',
          'Forwarded images exceed the total media limit',
        );
      }
      downloadedImages.forEach((downloaded, index) => {
        media.push({
          type: 'image',
          base64: downloaded.bytes.toString('base64'),
          mimeType: downloaded.mimeType,
          fileName: `forwarded-image-${index + 1}.${downloaded.extension}`,
        });
      });
    } else if (videoAttachments.length === 1) {
      const attachment = videoAttachments[0]!;
      let url = this.extractAttachmentUrl(attachment, 'video');
      if (!url) {
        const token = this.extractVideoToken(attachment);
        if (token) {
          try {
            url = await this.maxClient.getVideoDownloadUrl(token, {
              botId: publisherBotId,
              trafficClass: 'interactive',
              actionHealthLane: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_POST_IMPORT,
              timeoutMs: 5_000,
            });
          } catch (error: unknown) {
            const status = this.readHttpStatus(error);
            if (status === 400 || status === 403 || status === 404) {
              throw new PublisherPostImportTerminalError(
                'media_download_failed',
                'MAX video token is no longer available',
              );
            }
            throw new PublisherPostImportTransientError('MAX video token lookup failed');
          }
        }
      }
      if (!url) {
        throw new PublisherPostImportTerminalError(
          'media_download_failed',
          'Forwarded video has no durable download URL',
        );
      }
      const downloaded = await this.downloadMedia(url, PUBLICATION_MAX_VIDEO_BYTES, 'video');
      media.push({
        type: 'video',
        payload: null,
        base64: downloaded.bytes.toString('base64'),
        mimeType: downloaded.mimeType,
        fileName: `forwarded-video.${this.extensionForMime(downloaded.mimeType, 'mp4')}`,
      });
    }

    let importedText = rendered ?? sourceText;
    let textFormat: PublicationContentInput['textFormat'] = rendered ? 'markdown' : 'plain';
    if (importedText.trim().length === 0 && media.length === 0) {
      const shareUrl = shareAttachments
        .map((attachment) => this.extractSafeShareUrl(attachment))
        .find((candidate): candidate is string => candidate !== null);
      if (shareUrl) {
        importedText = shareUrl;
        textFormat = 'plain';
      }
    }
    if (importedText.trim().length === 0 && media.length === 0) {
      throw new PublisherPostImportTerminalError('unsupported_content', 'Forwarded post is empty');
    }
    return {
      text: importedText,
      textFormat,
      buttons: [],
      media,
      omissions: [...new Set(omissions)],
    };
  }

  private async prepareImportedImage(downloaded: {
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
    try {
      const validated = await this.maxClient.validateMediaUploadPayload('image', downloaded.bytes);
      return {
        bytes: downloaded.bytes,
        mimeType: validated.mimeType,
        extension: validated.extension,
      };
    } catch (error: unknown) {
      if (!(error instanceof MaxMediaUploadValidationError)) {
        throw error;
      }
      if (error.code !== MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT) {
        throw this.mapImageValidationFailure(error);
      }
    }

    try {
      return await normalizeUnsupportedMaxImageUpload(
        downloaded.bytes,
        PUBLICATION_MAX_IMAGE_BYTES,
      );
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw this.mapImageValidationFailure(error);
      }
      if (error instanceof MaxImageUploadNormalizationError) {
        if (error.code !== MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.TRANSCODE_FAILED) {
          const rejectionKind: PublisherPostImportRejectionKind =
            error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.DIMENSIONS_EXCEEDED
              ? 'image_normalization_dimensions_exceeded'
              : error.code ===
                  MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.INPUT_PIXEL_LIMIT_EXCEEDED
                ? 'image_normalization_input_pixel_limit_exceeded'
                : 'image_normalization_output_too_large';
          throw new PublisherPostImportTerminalError(
            'image_too_large',
            'Forwarded image cannot be normalized within the image limits',
            rejectionKind,
          );
        }
        throw new PublisherPostImportTerminalError(
          'media_download_failed',
          'Forwarded image could not be normalized',
          'image_transcode_failed',
        );
      }
      throw error;
    }
  }

  private mapImageValidationFailure(
    error: MaxMediaUploadValidationError,
  ): PublisherPostImportTerminalError {
    if (
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED ||
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED
    ) {
      return new PublisherPostImportTerminalError(
        'image_too_large',
        'Forwarded image exceeds the decode or dimension limit',
        error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED
          ? 'image_dimensions_exceeded'
          : 'image_decode_budget_exceeded',
      );
    }
    return new PublisherPostImportTerminalError(
      'media_download_failed',
      'Forwarded image bytes are invalid or unsupported after normalization',
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT
        ? 'image_format_unsupported_after_normalization'
        : 'image_invalid_payload',
    );
  }

  private async downloadMedia(
    sourceUrl: string,
    maxBytes: number,
    expectedType: 'image' | 'video',
  ): Promise<{ bytes: Buffer; mimeType: string }> {
    let current = this.parseAllowedMediaUrl(sourceUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POST_IMPORT_FETCH_TIMEOUT_MS);
    try {
      for (let redirect = 0; redirect <= 2; redirect += 1) {
        const response = await fetch(current, { signal: controller.signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location || redirect === 2) {
            throw new PublisherPostImportTerminalError(
              'media_download_failed',
              'MAX media redirect could not be followed safely',
            );
          }
          current = this.parseAllowedMediaUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          if (
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500
          ) {
            throw new PublisherPostImportTransientError(
              `MAX media download temporarily returned HTTP ${response.status}`,
            );
          }
          throw new PublisherPostImportTerminalError(
            'media_download_failed',
            `MAX media download returned HTTP ${response.status}`,
          );
        }
        const declaredSize = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
          throw new PublisherPostImportTerminalError(
            expectedType === 'image' ? 'image_too_large' : 'media_too_large',
            'Forwarded media exceeds its size limit',
          );
        }
        const bytes = await this.readResponseWithLimit(response, maxBytes, expectedType);
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        const mimeType = contentType.toLowerCase().startsWith(`${expectedType}/`)
          ? contentType.toLowerCase()
          : expectedType === 'image'
            ? 'image/jpeg'
            : 'video/mp4';
        return { bytes, mimeType };
      }
      throw new PublisherPostImportTerminalError(
        'media_download_failed',
        'MAX media redirect limit exceeded',
      );
    } catch (error: unknown) {
      if (error instanceof PublisherPostImportTerminalError) {
        throw error;
      }
      if (error instanceof PublisherPostImportTransientError) {
        throw error;
      }
      throw new PublisherPostImportTransientError(
        error instanceof Error ? error.message : 'MAX media transport failed',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readResponseWithLimit(
    response: Response,
    maxBytes: number,
    expectedType: 'image' | 'video',
  ): Promise<Buffer> {
    if (!response.body) {
      throw new PublisherPostImportTerminalError(
        'media_download_failed',
        'MAX media body is empty',
      );
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PublisherPostImportTerminalError(
          expectedType === 'image' ? 'image_too_large' : 'media_too_large',
          'Forwarded media exceeds its size limit',
        );
      }
      chunks.push(Buffer.from(value));
    }
    if (total === 0) {
      throw new PublisherPostImportTerminalError('media_download_failed', 'MAX media is empty');
    }
    return Buffer.concat(chunks, total);
  }

  private parseAllowedMediaUrl(value: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new PublisherPostImportTerminalError('media_download_failed', 'Invalid MAX media URL');
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
    const allowed = POST_IMPORT_ALLOWED_MEDIA_HOSTS.some(
      (root) => hostname === root || hostname.endsWith(`.${root}`),
    );
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      (parsed.port !== '' && parsed.port !== '443') ||
      !allowed
    ) {
      throw new PublisherPostImportTerminalError('media_download_failed', 'Unsafe MAX media URL');
    }
    return parsed;
  }

  private extractAttachmentUrl(
    attachment: Record<string, unknown>,
    expectedType: 'image' | 'video',
  ): string | null {
    const payload = this.asRecord(attachment.payload) ?? attachment;
    const candidates: Array<{ url: string; score: number }> = [];
    const visit = (value: unknown, key: string, depth: number): void => {
      if (depth > 4) {
        return;
      }
      if (typeof value === 'string' && /^https:\/\//iu.test(value.trim())) {
        const normalizedKey = key.toLowerCase();
        let score = normalizedKey.includes('download') ? 500 : normalizedKey === 'url' ? 300 : 100;
        if (expectedType === 'image' && normalizedKey.includes('preview')) {
          score -= 50;
        }
        candidates.push({ url: value.trim(), score });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, key, depth + 1));
        return;
      }
      const row = this.asRecord(value);
      if (!row) {
        return;
      }
      const width = this.readNumber(row.width ?? row.w) ?? 0;
      const height = this.readNumber(row.height ?? row.h) ?? 0;
      for (const [nestedKey, nestedValue] of Object.entries(row)) {
        const before = candidates.length;
        visit(nestedValue, nestedKey, depth + 1);
        for (let index = before; index < candidates.length; index += 1) {
          candidates[index]!.score += Math.min(200, Math.floor((width * height) / 100_000));
        }
      }
    };
    visit(payload, 'payload', 0);
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url ?? null;
  }

  private extractVideoToken(attachment: Record<string, unknown>): string | null {
    const payload = this.asRecord(attachment.payload) ?? attachment;
    return this.readString(
      payload.token ?? payload.video_token ?? payload.videoToken ?? payload.id,
    );
  }

  private extractSafeShareUrl(attachment: Record<string, unknown>): string | null {
    const payload = this.asRecord(attachment.payload);
    const candidate = this.readString(payload?.url);
    if (!candidate || candidate.length > POST_IMPORT_MAX_TEXT_LENGTH) {
      return null;
    }
    try {
      const parsed = new URL(candidate);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password
      ) {
        return null;
      }
      const normalized = parsed.toString();
      return normalized.length <= POST_IMPORT_MAX_TEXT_LENGTH ? normalized : null;
    } catch {
      return null;
    }
  }

  private async mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    operation: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= values.length) {
            return;
          }
          results[index] = await operation(values[index]!, index);
        }
      },
    );
    await Promise.all(workers);
    return results;
  }

  private async loadRemoteIncomingMessage(
    privateChatId: string,
    incomingMessageId: string,
    publisherBotId: string,
  ): Promise<Record<string, unknown>> {
    const exactResponse = await this.maxClient.getExactMessageRow(
      privateChatId,
      incomingMessageId,
      {
        botId: publisherBotId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_POST_IMPORT,
        timeoutMs: 5_000,
      },
    );
    if (!exactResponse) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forwarded message disappeared before import',
      );
    }
    return this.resolveExactMessage(exactResponse, incomingMessageId);
  }

  private async loadPersistedForwardReceipt(params: {
    sourceWebhookEventId: string | null;
    publisherBotId: string;
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  }): Promise<Record<string, unknown> | null> {
    const sourceWebhookEventId = params.sourceWebhookEventId?.trim() ?? '';
    if (!sourceWebhookEventId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt identity is unavailable',
        'receipt_identity_missing',
      );
    }
    const receipt = await this.prisma.webhookEvent.findUnique({
      where: { id: sourceWebhookEventId },
      select: { botId: true, normalizedPayload: true },
    });
    if (!receipt) {
      return null;
    }
    if (receipt.botId?.trim() !== params.publisherBotId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt does not belong to Publisher',
        'receipt_bot_mismatch',
      );
    }
    const parsed = maxUpdateSchema.safeParse(receipt.normalizedPayload);
    if (!parsed.success) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt payload is invalid',
        'receipt_payload_invalid',
      );
    }
    const update = parsed.data;
    const normalizedMessage = update.message;
    if (
      update.botId?.trim() !== params.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_created' ||
      normalizedMessage?.messageId !== params.incomingMessageId ||
      normalizedMessage.chatId !== params.privateChatId ||
      normalizedMessage.senderId !== params.actorUserId
    ) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward receipt identity does not match the import session',
        'receipt_normalized_identity_mismatch',
      );
    }
    const raw = this.asRecord(update.raw);
    const rawType = this.readString(raw?.update_type ?? raw?.type)?.toLowerCase();
    const rawMessage = this.extractRawWebhookMessage(raw);
    const recipient = this.asRecord(rawMessage?.recipient);
    const sender = this.asRecord(rawMessage?.sender);
    const link = this.asRecord(rawMessage?.link);
    const rawMessageId = rawMessage ? this.readMessageId(rawMessage) : null;
    const rawMessageIdMatches = rawMessageId
      ? rawMessageId === params.incomingMessageId
      : params.incomingMessageId === `message_created:${update.updateId}`;
    if (
      rawType !== 'message_created' ||
      this.readString(recipient?.chat_id ?? recipient?.chatId) !== params.privateChatId ||
      this.readString(recipient?.chat_type ?? recipient?.chatType)?.toLowerCase() !== 'dialog' ||
      this.readString(sender?.user_id ?? sender?.userId ?? sender?.id) !== params.actorUserId ||
      !rawMessageIdMatches ||
      this.readString(link?.type)?.toLowerCase() !== 'forward' ||
      !this.asRecord(link?.message)
    ) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Forward raw identity does not match the authenticated receipt',
        'receipt_raw_identity_mismatch',
      );
    }
    return rawMessage!;
  }

  private extractRawWebhookMessage(
    raw: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    const direct = this.asRecord(raw?.message);
    if (direct) {
      return direct;
    }
    for (const key of ['message_created', 'data', 'event']) {
      const envelope = this.asRecord(raw?.[key]);
      const message = this.asRecord(envelope?.message);
      if (message) {
        return message;
      }
    }
    return null;
  }

  private resolveExactMessage(
    response: Record<string, unknown>,
    expectedMessageId: string,
  ): Record<string, unknown> {
    const nested = this.asRecord(response.message);
    if (nested && this.readMessageId(nested) === expectedMessageId) {
      return nested;
    }
    return response;
  }

  private assertExactSender(message: Record<string, unknown>, actorUserId: string): void {
    const sender = this.asRecord(message.sender);
    const senderId = this.readString(
      sender?.user_id ?? sender?.userId ?? sender?.id ?? message.sender_id ?? message.senderId,
    );
    if (senderId !== actorUserId) {
      throw new PublisherPostImportTerminalError(
        'message_unavailable',
        'Exact message sender does not match the import owner',
      );
    }
  }

  private extractLinkedForward(message: Record<string, unknown>): Record<string, unknown> | null {
    const link = this.asRecord(message.link);
    return this.readString(link?.type)?.toLowerCase() === 'forward'
      ? this.asRecord(link?.message)
      : null;
  }

  private extractText(message: Record<string, unknown>): string {
    const body = this.asRecord(message.body);
    return this.readText(message.text ?? body?.text) ?? '';
  }

  private extractAttachments(message: Record<string, unknown>): Record<string, unknown>[] {
    const body = this.asRecord(message.body);
    const value = Array.isArray(message.attachments)
      ? message.attachments
      : Array.isArray(body?.attachments)
        ? body.attachments
        : [];
    return value.flatMap((item) => {
      const row = this.asRecord(item);
      return row ? [row] : [];
    });
  }

  private readAttachmentType(attachment: Record<string, unknown>): string {
    return this.readString(attachment.type)?.toLowerCase() ?? '';
  }

  private readMessageId(message: Record<string, unknown>): string | null {
    const body = this.asRecord(message.body);
    return this.readString(
      message.mid ?? message.id ?? message.message_id ?? message.messageId ?? body?.mid,
    );
  }

  private extensionForMime(mimeType: string, fallback: string): string {
    const subtype = mimeType
      .split('/')[1]
      ?.split('+')[0]
      ?.replace(/[^a-z0-9]/giu, '');
    return subtype || fallback;
  }

  private async fail(
    sessionId: string,
    lockToken: string,
    failureCode: PublisherPostImportFailureCode,
  ): Promise<boolean> {
    const failed = await this.prisma.publisherPostImportSession.updateMany({
      where: {
        id: sessionId,
        status: PublisherPostImportStatus.PROCESSING,
        lockToken,
      },
      data: {
        status: PublisherPostImportStatus.FAILED,
        failureCode,
        notificationKind: 'failed',
        notificationPending: true,
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
        captureGuardUntil: new Date(Date.now() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS),
        lockedAt: null,
        lockToken: null,
        expiresAt: new Date(Date.now() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
      },
    });
    return failed.count > 0;
  }

  private logTerminalFailure(
    sessionId: string,
    failureCode: PublisherPostImportFailureCode,
    rejectionKind: PublisherPostImportRejectionKind,
    snapshotSource: PublisherPostImportSnapshotSource,
  ): void {
    this.logger.log(
      { sessionId, failureCode, rejectionKind, snapshotSource },
      'Publisher forwarded post import rejected',
    );
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private readText(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
  }

  private readHttpStatus(error: unknown): number | null {
    const status = (error as { response?: { status?: unknown }; status?: unknown })?.response
      ?.status;
    const direct = (error as { status?: unknown })?.status;
    const value = typeof status === 'number' ? status : direct;
    return typeof value === 'number' && Number.isInteger(value) ? value : null;
  }
}
