import { maxUpdateSchema } from '@maxim/contracts';
import type { PublicationTextFormat } from '@maxim/contracts/publication';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  extractIncomingMessageMarkup,
  renderIncomingMarkupAsMarkdown,
} from '../moderation/private-control-markup-importer';
import {
  MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES,
  MaxImageUploadNormalizationError,
  normalizeUnsupportedMaxImageUpload,
} from '../max/max-image-upload-normalization';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from '../admin/publication-media-limits';

const MAX_TEXT_LENGTH = 4_000;
const MAX_IMAGES = 10;
const FETCH_TIMEOUT_MS = 20_000;
const ALLOWED_MEDIA_HOSTS = ['max.ru', 'oneme.ru', 'mycdn.me', 'okcdn.ru'] as const;

export type PublisherAutoReplyCaptureFailureCode =
  | 'message_unavailable'
  | 'unsupported_content'
  | 'text_too_long'
  | 'too_many_images'
  | 'duplicate_images'
  | 'image_too_large'
  | 'media_too_large'
  | 'media_download_failed';

export class PublisherAutoReplyCaptureError extends Error {
  constructor(
    readonly code: PublisherAutoReplyCaptureFailureCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PublisherAutoReplyCaptureError';
  }
}

export type PublisherAutoReplyCapturedImage = {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
};

export type PublisherAutoReplyCapturedContent = {
  text: string;
  textFormat: PublicationTextFormat;
  images: PublisherAutoReplyCapturedImage[];
  omissions: Array<
    'buttons_not_imported' | 'attachments_not_imported' | 'formatting_not_preserved'
  >;
};

@Injectable()
export class PublisherAutoReplyContentCaptureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
  ) {}

  async capture(params: {
    webhookEventId: string | null;
    publisherBotId: string;
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  }): Promise<PublisherAutoReplyCapturedContent> {
    const persistedMessage = params.webhookEventId ? await this.loadPersistedReceipt(params) : null;
    if (persistedMessage) {
      try {
        return await this.captureMessage(persistedMessage, params.actorUserId);
      } catch (error: unknown) {
        if (
          !(error instanceof PublisherAutoReplyCaptureError) ||
          error.code !== 'media_download_failed'
        ) {
          throw error;
        }
      }
    }
    const remoteMessage = await this.loadRemoteMessage(params);
    return this.captureMessage(remoteMessage, params.actorUserId);
  }

  private captureMessage(
    exactMessage: Record<string, unknown>,
    actorUserId: string,
  ): Promise<PublisherAutoReplyCapturedContent> {
    this.assertSender(exactMessage, actorUserId);

    const link = asRecord(exactMessage.link);
    const source =
      readLowerString(link?.type) === 'forward'
        ? (asRecord(link?.message) ?? asRecord(link?.body))
        : exactMessage;
    if (!source) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Incoming auto-reply content is unavailable',
      );
    }
    return this.buildContent(source);
  }

  private async buildContent(
    source: Record<string, unknown>,
  ): Promise<PublisherAutoReplyCapturedContent> {
    const text = extractText(source);
    if (text.length > MAX_TEXT_LENGTH) {
      throw new PublisherAutoReplyCaptureError('text_too_long', 'Auto-reply text is too long');
    }
    const markup = extractIncomingMessageMarkup(source);
    let rendered = markup.length > 0 ? renderIncomingMarkupAsMarkdown(text, markup) : null;
    const omissions: PublisherAutoReplyCapturedContent['omissions'] = [];
    if (markup.length > 0 && rendered === null) {
      omissions.push('formatting_not_preserved');
    }
    if (rendered && rendered.length > MAX_TEXT_LENGTH) {
      rendered = null;
      omissions.push('formatting_not_preserved');
    }

    const rawAttachments = extractAttachments(source);
    const imageAttachments: Record<string, unknown>[] = [];
    for (const attachment of rawAttachments) {
      const type = readLowerString(attachment.type);
      if (type === 'image' || type === 'photo') {
        imageAttachments.push(attachment);
      } else if (type === 'inline_keyboard') {
        omissions.push('buttons_not_imported');
      } else if (type !== 'share') {
        omissions.push('attachments_not_imported');
      }
    }
    if (imageAttachments.length > MAX_IMAGES) {
      throw new PublisherAutoReplyCaptureError('too_many_images', 'Too many auto-reply images');
    }
    if (
      rawAttachments.some((attachment) => {
        const type = readLowerString(attachment.type);
        return type === 'video' || type === 'audio' || type === 'file';
      })
    ) {
      throw new PublisherAutoReplyCaptureError(
        'unsupported_content',
        'Auto-replies support text and photos only',
      );
    }

    const images = await mapWithConcurrency(imageAttachments, 3, async (attachment, index) => {
      const url = extractAttachmentUrl(attachment);
      if (!url) {
        throw new PublisherAutoReplyCaptureError(
          'media_download_failed',
          'Incoming photo has no durable download URL',
        );
      }
      const downloaded = await this.downloadImage(url);
      const normalized = await this.prepareImage(downloaded);
      return {
        bytes: normalized.bytes,
        mimeType: normalized.mimeType,
        fileName: `auto-reply-image-${index + 1}.${normalized.extension}`,
      };
    });
    const totalBytes = images.reduce((total, image) => total + image.bytes.length, 0);
    const imageHashes = images.map((image) =>
      createHash('sha256').update(image.bytes).digest('hex'),
    );
    if (new Set(imageHashes).size !== imageHashes.length) {
      throw new PublisherAutoReplyCaptureError(
        'duplicate_images',
        'The same auto-reply photo was attached more than once',
      );
    }
    if (totalBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new PublisherAutoReplyCaptureError(
        'media_too_large',
        'Auto-reply photos exceed the total media limit',
      );
    }

    const importedText = rendered ?? text;
    if (!importedText.trim() && images.length === 0) {
      throw new PublisherAutoReplyCaptureError(
        'unsupported_content',
        'Auto-reply content is empty',
      );
    }
    return {
      text: importedText,
      textFormat: rendered ? 'markdown' : 'plain',
      images,
      omissions: [...new Set(omissions)],
    };
  }

  private async prepareImage(input: { bytes: Buffer; mimeType: string }): Promise<{
    bytes: Buffer;
    mimeType: string;
    extension: string;
  }> {
    try {
      const validated = await this.maxClient.validateMediaUploadPayload('image', input.bytes);
      return { bytes: input.bytes, mimeType: validated.mimeType, extension: validated.extension };
    } catch (error: unknown) {
      if (!(error instanceof MaxMediaUploadValidationError)) throw error;
      if (error.code !== MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.UNSUPPORTED_FORMAT) {
        throw this.mapImageError(error);
      }
    }

    try {
      return await normalizeUnsupportedMaxImageUpload(input.bytes, PUBLICATION_MAX_IMAGE_BYTES);
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) throw this.mapImageError(error);
      if (error instanceof MaxImageUploadNormalizationError) {
        throw new PublisherAutoReplyCaptureError(
          error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.DIMENSIONS_EXCEEDED ||
            error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.INPUT_PIXEL_LIMIT_EXCEEDED ||
            error.code === MAX_IMAGE_UPLOAD_NORMALIZATION_ERROR_CODES.OUTPUT_TOO_LARGE
            ? 'image_too_large'
            : 'media_download_failed',
          'Incoming photo could not be normalized',
        );
      }
      throw error;
    }
  }

  private mapImageError(error: MaxMediaUploadValidationError): PublisherAutoReplyCaptureError {
    return new PublisherAutoReplyCaptureError(
      error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED ||
        error.code === MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED
        ? 'image_too_large'
        : 'media_download_failed',
      'Incoming photo is invalid or too large',
    );
  }

  private async downloadImage(url: string): Promise<{ bytes: Buffer; mimeType: string }> {
    let current = parseAllowedMediaUrl(url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      for (let redirect = 0; redirect <= 2; redirect += 1) {
        const response = await fetch(current, { signal: controller.signal, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => undefined);
          if (!location || redirect === 2) {
            throw new PublisherAutoReplyCaptureError(
              'media_download_failed',
              'MAX image redirect could not be followed safely',
            );
          }
          current = parseAllowedMediaUrl(new URL(location, current).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const retryable =
            response.status === 408 ||
            response.status === 425 ||
            response.status === 429 ||
            response.status >= 500;
          throw new PublisherAutoReplyCaptureError(
            'media_download_failed',
            `MAX image download returned HTTP ${response.status}`,
            retryable,
          );
        }
        const declaredSize = Number(response.headers.get('content-length') ?? 0);
        if (Number.isFinite(declaredSize) && declaredSize > PUBLICATION_MAX_IMAGE_BYTES) {
          throw new PublisherAutoReplyCaptureError(
            'image_too_large',
            'Incoming photo is too large',
          );
        }
        const bytes = await readResponseWithLimit(response, PUBLICATION_MAX_IMAGE_BYTES);
        const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim();
        return {
          bytes,
          mimeType: contentType.toLowerCase().startsWith('image/')
            ? contentType.toLowerCase()
            : 'image/jpeg',
        };
      }
      throw new PublisherAutoReplyCaptureError(
        'media_download_failed',
        'MAX image redirect limit exceeded',
      );
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyCaptureError) throw error;
      throw new PublisherAutoReplyCaptureError(
        'media_download_failed',
        error instanceof Error ? error.message : 'MAX image transport failed',
        true,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async loadPersistedReceipt(params: {
    webhookEventId: string | null;
    publisherBotId: string;
    actorUserId: string;
    privateChatId: string;
    incomingMessageId: string;
  }): Promise<Record<string, unknown> | null> {
    const receipt = await this.prisma.webhookEvent.findUnique({
      where: { id: params.webhookEventId ?? '' },
      select: { botId: true, normalizedPayload: true },
    });
    if (!receipt) return null;
    if (receipt.botId?.trim() !== params.publisherBotId) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Auto-reply receipt belongs to another bot',
      );
    }
    const parsed = maxUpdateSchema.safeParse(receipt.normalizedPayload);
    if (!parsed.success) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Auto-reply receipt is invalid',
      );
    }
    const update = parsed.data;
    if (
      update.botId?.trim() !== params.publisherBotId ||
      update.type.trim().toLowerCase() !== 'message_created' ||
      update.message?.messageId !== params.incomingMessageId ||
      update.message.chatId !== params.privateChatId ||
      update.message.senderId !== params.actorUserId
    ) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Auto-reply receipt identity does not match the session',
      );
    }
    return extractRawMessage(update.raw);
  }

  private async loadRemoteMessage(params: {
    publisherBotId: string;
    privateChatId: string;
    incomingMessageId: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.maxClient.getExactMessageRow(
      params.privateChatId,
      params.incomingMessageId,
      {
        botId: params.publisherBotId,
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.PUBLISHER_AUTO_REPLY,
        timeoutMs: 5_000,
      },
    );
    if (!response) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Auto-reply source message is no longer available',
      );
    }
    const nested = asRecord(response.message);
    return nested && readMessageId(nested) === params.incomingMessageId ? nested : response;
  }

  private assertSender(message: Record<string, unknown>, actorUserId: string): void {
    const sender = asRecord(message.sender);
    const senderId = readString(
      sender?.user_id ?? sender?.userId ?? sender?.id ?? message.sender_id ?? message.senderId,
    );
    if (senderId !== actorUserId) {
      throw new PublisherAutoReplyCaptureError(
        'message_unavailable',
        'Auto-reply source sender does not match the session owner',
      );
    }
  }
}

function extractRawMessage(rawValue: unknown): Record<string, unknown> | null {
  const raw = asRecord(rawValue);
  if (!raw) return null;
  const direct = asRecord(raw.message);
  if (direct) return direct;
  for (const key of ['message_created', 'data', 'event']) {
    const envelope = asRecord(raw[key]);
    const nested = asRecord(envelope?.message);
    if (nested) return nested;
  }
  return null;
}

function extractText(message: Record<string, unknown>): string {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  return readText(message.text ?? body?.text ?? content?.text) ?? '';
}

function extractAttachments(message: Record<string, unknown>): Record<string, unknown>[] {
  const body = asRecord(message.body);
  const content = asRecord(message.content);
  const values = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(body?.attachments)
      ? body.attachments
      : Array.isArray(content?.attachments)
        ? content.attachments
        : [];
  return values.flatMap((value) => {
    const row = asRecord(value);
    return row ? [row] : [];
  });
}

function extractAttachmentUrl(attachment: Record<string, unknown>): string | null {
  const payload = asRecord(attachment.payload) ?? attachment;
  const candidates: Array<{ url: string; score: number }> = [];
  const visit = (value: unknown, key: string, depth: number): void => {
    if (depth > 4) return;
    if (typeof value === 'string' && /^https:\/\//iu.test(value.trim())) {
      const normalizedKey = key.toLowerCase();
      const score = normalizedKey.includes('download')
        ? 500
        : normalizedKey === 'url'
          ? 300
          : normalizedKey.includes('preview')
            ? 50
            : 100;
      candidates.push({ url: value.trim(), score });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key, depth + 1));
      return;
    }
    const row = asRecord(value);
    if (!row) return;
    const width = readNumber(row.width ?? row.w) ?? 0;
    const height = readNumber(row.height ?? row.h) ?? 0;
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

function parseAllowedMediaUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublisherAutoReplyCaptureError('media_download_failed', 'Invalid MAX image URL');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const allowed = ALLOWED_MEDIA_HOSTS.some(
    (root) => hostname === root || hostname.endsWith(`.${root}`),
  );
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port !== '' && parsed.port !== '443') ||
    !allowed
  ) {
    throw new PublisherAutoReplyCaptureError('media_download_failed', 'Unsafe MAX image URL');
  }
  return parsed;
}

async function readResponseWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    throw new PublisherAutoReplyCaptureError('media_download_failed', 'MAX image body is empty');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PublisherAutoReplyCaptureError('image_too_large', 'Incoming photo is too large');
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) {
    throw new PublisherAutoReplyCaptureError('media_download_failed', 'MAX image is empty');
  }
  return Buffer.concat(chunks, total);
}

async function mapWithConcurrency<T, R>(
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
        const index = cursor++;
        if (index >= values.length) return;
        results[index] = await operation(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function readMessageId(message: Record<string, unknown>): string | null {
  const body = asRecord(message.body);
  return readString(
    message.mid ?? message.id ?? message.message_id ?? message.messageId ?? body?.mid,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}
