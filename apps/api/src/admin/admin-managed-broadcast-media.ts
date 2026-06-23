import { BadRequestException } from '@nestjs/common';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import { isMaxApiThrottleError, isMaxApiTimeoutError } from './admin-legacy-utils';
import {
  BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS,
  BROADCAST_THROTTLE_RETRY_DELAYS_MS,
  BROADCAST_TIMEOUT_RETRY_DELAYS_MS,
} from './admin.service.support';

export type ManagedBroadcastRetriableAttachmentOptions =
  | Pick<
      MaxSendMessageOptions,
      'button' | 'buttons' | 'imagePayload' | 'attachments' | 'textFormat'
    >
  | undefined;

export function resolveManagedBroadcastSendRetryDelayMs(
  error: unknown,
  attempt: number,
  options: ManagedBroadcastRetriableAttachmentOptions,
): number | null {
  if (hasRetriableManagedBroadcastAttachment(options) && isAttachmentNotReadyError(error)) {
    return BROADCAST_IMAGE_SEND_RETRY_DELAYS_MS[attempt - 1] ?? null;
  }

  if (isMaxApiThrottleError(error)) {
    return BROADCAST_THROTTLE_RETRY_DELAYS_MS[attempt - 1] ?? null;
  }

  if (isMaxApiTimeoutError(error)) {
    return BROADCAST_TIMEOUT_RETRY_DELAYS_MS[attempt - 1] ?? null;
  }

  return null;
}

export function hasRetriableManagedBroadcastAttachment(
  options: ManagedBroadcastRetriableAttachmentOptions,
): boolean {
  return Boolean(options?.imagePayload) || Boolean(options?.attachments?.length);
}

export function isAttachmentNotReadyError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status !== 400) {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? '').toLowerCase();
  return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
}

export function isManagedBroadcastSlotConflictError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code !== 'P2002') {
    return false;
  }

  const metaTarget = (error as { meta?: { target?: unknown } })?.meta?.target;
  const targetValue = Array.isArray(metaTarget)
    ? metaTarget.map((item) => String(item).toLowerCase()).join(',')
    : typeof metaTarget === 'string'
      ? metaTarget.toLowerCase()
      : '';
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  return (
    targetValue.includes('managed_broadcast_occurrences_slot_key') ||
    targetValue.includes('source_chat_id') ||
    targetValue.includes('sourcechatid') ||
    message.includes('managed_broadcast_occurrences_slot_key')
  );
}

export function decodeBroadcastImageBase64(value: string): Buffer {
  const normalized = value.trim().replace(/^data:[^;]+;base64,/, '');
  if (!normalized) {
    throw new BadRequestException('Добавьте фото для автопостинга.');
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = Buffer.from(normalized, 'base64');
  } catch {
    throw new BadRequestException('Не удалось прочитать фото.');
  }

  if (imageBuffer.length === 0) {
    throw new BadRequestException('Не удалось прочитать фото.');
  }

  return imageBuffer;
}

export function resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
  const trimmed = fileName.trim();
  if (trimmed) {
    return trimmed;
  }

  if (mimeType === 'image/png') {
    return 'broadcast-image.png';
  }
  if (mimeType === 'image/webp') {
    return 'broadcast-image.webp';
  }
  if (mimeType === 'image/gif') {
    return 'broadcast-image.gif';
  }

  return 'broadcast-image.jpg';
}
