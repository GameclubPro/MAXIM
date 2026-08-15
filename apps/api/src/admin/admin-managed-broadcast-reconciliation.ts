import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ManagedBroadcastDeliveryStatus as PrismaManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  Prisma,
  type ManagedBroadcast as PersistedManagedBroadcast,
  type ManagedBroadcastDelivery as PersistedManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import {
  isMaxMediaUploadValidationPublicMessage,
  MaxMediaUploadValidationError,
} from '../max/max-media-upload-validation';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { isPrivateDialogChatUnavailableError } from './admin-legacy-utils';
import { ManagedBroadcastTransientUploadError } from './admin-managed-broadcast-media-runtime';
import { getCurrentManagedBroadcastOccurrence } from './admin-managed-broadcast-planner';
import {
  MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS,
  MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS,
  MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES,
  MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX,
  type ManagedBroadcastDeliverySnapshot,
  type ManagedBroadcastFailureBreakdown,
} from './admin.service.support';

export function shouldAutoRetryManagedBroadcastDeliveryFailure(
  delivery: PersistedManagedBroadcastDelivery,
  nowMs = Date.now(),
): boolean {
  if (delivery.attemptCount >= MANAGED_BROADCAST_MAX_AUTO_RETRY_ATTEMPTS) return false;
  if (delivery.updatedAt.getTime() + MANAGED_BROADCAST_AUTO_RETRY_BACKOFF_MS > nowMs) return false;
  return isManagedBroadcastAutoRetryableDeliveryFailureMessage(delivery.lastError ?? '');
}

export function markManagedBroadcastSendPhase(error: unknown, sendStarted: boolean): Error {
  const source = error as { response?: unknown; code?: unknown; preDispatch?: unknown };
  const marked =
    error instanceof Error && Object.isExtensible(error)
      ? (error as Error & { managedBroadcastSendStarted?: boolean })
      : (new Error(error instanceof Error ? error.message : String(error), {
          cause: error,
        }) as Error & {
          managedBroadcastSendStarted?: boolean;
          response?: unknown;
          code?: unknown;
        });
  marked.managedBroadcastSendStarted = sendStarted && source?.preDispatch !== true;
  if (!('response' in marked) && source?.response !== undefined) {
    (marked as Error & { response?: unknown }).response = source.response;
  }
  if (!('code' in marked) && source?.code !== undefined) {
    (marked as Error & { code?: unknown }).code = source.code;
  }
  return marked;
}

export function isAmbiguousManagedBroadcastSendError(error: unknown): boolean {
  return (
    (error as { managedBroadcastSendStarted?: unknown })?.managedBroadcastSendStarted === true &&
    isAmbiguousMaxSendError(error)
  );
}

export function buildManagedBroadcastAutoRetryableFailureWhere(): Prisma.ManagedBroadcastDeliveryWhereInput[] {
  return [
    { lastError: null },
    { lastError: { contains: 'timeout', mode: 'insensitive' } },
    { lastError: { contains: 'rate limit exceeded', mode: 'insensitive' } },
    { lastError: { contains: 'circuit breaker', mode: 'insensitive' } },
    { lastError: { contains: 'attachment.not.ready', mode: 'insensitive' } },
    { lastError: { contains: 'not ready', mode: 'insensitive' } },
    { lastError: { contains: 'temporarily unavailable', mode: 'insensitive' } },
    { lastError: { contains: 'service unavailable', mode: 'insensitive' } },
    { lastError: { contains: 'socket hang up', mode: 'insensitive' } },
    { lastError: { contains: 'econnaborted', mode: 'insensitive' } },
    { lastError: { contains: 'econnreset', mode: 'insensitive' } },
    { lastError: { contains: 'network error', mode: 'insensitive' } },
    { lastError: { contains: 'too many requests', mode: 'insensitive' } },
    { lastError: { contains: 'Не удалось загрузить фото', mode: 'insensitive' } },
    { lastError: { contains: '429', mode: 'insensitive' } },
  ];
}

export function isManagedBroadcastAutoRetryableDeliveryFailureMessage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return [
    'timeout',
    'rate limit exceeded',
    'circuit breaker',
    'attachment.not.ready',
    'not ready',
    'temporarily unavailable',
    'service unavailable',
    'socket hang up',
    'econnaborted',
    'econnreset',
    'network error',
    'too many requests',
    'не удалось загрузить фото',
    '429',
  ].some((marker) => normalized.includes(marker));
}

export function isManagedBroadcastTransientDeliveryFailureMessage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return [
    'timeout',
    'rate limit exceeded',
    'circuit breaker',
    'attachment.not.ready',
    'not ready',
    'temporarily unavailable',
    'service unavailable',
    'socket hang up',
    'econnaborted',
    'econnreset',
    'network error',
    'не удалось загрузить фото',
    'прошлая попытка была прервана после старта отправки',
  ].some((marker) => normalized.includes(marker));
}

export function isManagedBroadcastTransientQuarantineFailureMessage(value: string): boolean {
  return value
    .trim()
    .toLowerCase()
    .startsWith(MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX.toLowerCase());
}

export function buildManagedBroadcastTransientQuarantineMessage(
  transientFailureAttempts: number,
  transientFailureOccurrences: number,
  lastFailureMessage: string,
): string {
  const reason =
    transientFailureOccurrences >= MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
      ? `${MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX}: ${transientFailureOccurrences} проблемных слота подряд.`
      : `${MANAGED_BROADCAST_TRANSIENT_QUARANTINE_REASON_PREFIX}: ${transientFailureAttempts} неудачных попыток.`;
  const normalizedLastFailureMessage = lastFailureMessage.trim();
  return normalizedLastFailureMessage
    ? `${reason} Последняя ошибка: ${normalizedLastFailureMessage}`
    : reason;
}

export function isManagedBroadcastPermanentTargetDeliveryFailure(
  error: unknown,
  failureMessage: string,
): boolean {
  if (error && isPrivateDialogChatUnavailableError(error)) return true;
  const normalized = failureMessage.trim().toLowerCase();
  if (!normalized) return false;
  return (
    normalized.includes('chat closed') ||
    normalized.includes('chat not found') ||
    /^chat\s+.+\s+not found$/i.test(failureMessage.trim()) ||
    normalized.includes('not active chat member') ||
    normalized.includes('not a chat member') ||
    normalized.includes('bot is not a chat member') ||
    normalized.includes('not accessible') ||
    normalized.includes('forbidden') ||
    normalized.includes('chat.denied') ||
    normalized.includes('chat.not.found')
  );
}

export function resolveManagedBroadcastFatalProcessingErrorMessage(error: unknown): string | null {
  if (error instanceof ManagedBroadcastTransientUploadError) return null;
  if (error instanceof MaxMediaUploadValidationError) return error.publicMessage;
  if (!(error instanceof BadRequestException)) return null;
  const response = error.getResponse();
  if (typeof response === 'string' && response.trim()) return response.trim();
  const message = (response as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message.trim()) return message.trim();
  if (Array.isArray(message)) {
    const normalized = message.find(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
    if (normalized) return normalized.trim();
  }
  return error.message.trim() || null;
}

export function resolveManagedBroadcastFatalProcessingFailureMessage(
  failureMessage: string | null | undefined,
): string | null {
  const normalized = failureMessage?.trim();
  if (!normalized) return null;
  return isMaxMediaUploadValidationPublicMessage(normalized) ||
    normalized === 'Поддерживаются только изображения.' ||
    normalized === 'Фото слишком большое. Попробуйте другое изображение.'
    ? normalized
    : null;
}

export function buildManagedBroadcastFailureMessage(
  failedChats: number,
  firstSendError: unknown,
): string {
  return (
    extractMaxApiErrorMessage(firstSendError) ||
    (firstSendError instanceof Error && firstSendError.message.trim()
      ? firstSendError.message
      : `Не удалось отправить в ${failedChats} чат(ов).`)
  );
}

export function createEmptyManagedBroadcastFailureBreakdown(): ManagedBroadcastFailureBreakdown {
  return { transient: 0, permanentTarget: 0, quarantined: 0, unknown: 0 };
}

export function createManagedBroadcastDeliverySnapshot(
  row: PersistedManagedBroadcast,
  deliveries: PersistedManagedBroadcastDelivery[],
): ManagedBroadcastDeliverySnapshot {
  const failureBreakdown = createEmptyManagedBroadcastFailureBreakdown();
  for (const delivery of deliveries) {
    if (
      delivery.status !== PrismaManagedBroadcastDeliveryStatus.FAILED &&
      delivery.status !== PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS &&
      delivery.status !== PrismaManagedBroadcastDeliveryStatus.CANCELED
    )
      continue;

    const failureMessage = delivery.lastError ?? '';
    if (isManagedBroadcastTransientQuarantineFailureMessage(failureMessage)) {
      failureBreakdown.quarantined += 1;
    } else if (isManagedBroadcastPermanentTargetDeliveryFailure(null, failureMessage)) {
      failureBreakdown.permanentTarget += 1;
    } else if (isManagedBroadcastTransientDeliveryFailureMessage(failureMessage)) {
      failureBreakdown.transient += 1;
    } else {
      failureBreakdown.unknown += 1;
    }
  }

  return {
    currentOccurrence: getCurrentManagedBroadcastOccurrence(row),
    deliveredChats: deliveries.filter(
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.SENT,
    ).length,
    failedChats: deliveries.filter(
      (delivery) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.AMBIGUOUS,
    ).length,
    pendingChats: deliveries.filter(
      (delivery) =>
        delivery.status === PrismaManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === PrismaManagedBroadcastDeliveryStatus.SENDING,
    ).length,
    blockedChats: deliveries.filter(
      (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.CANCELED,
    ).length,
    failureBreakdown,
    canRetry:
      (row.status === PrismaManagedBroadcastStatus.PARTIAL ||
        row.status === PrismaManagedBroadcastStatus.FAILED) &&
      deliveries.some(
        (delivery) => delivery.status === PrismaManagedBroadcastDeliveryStatus.FAILED,
      ),
  };
}

export function buildManagedBroadcastDeliveryActionKey(
  row: PersistedManagedBroadcast,
  occurrenceIndex: number,
  targetChatId: string,
  attemptCount = 1,
): string {
  const contentRevision = row.publicationContentRevisionId
    ? `publication-${row.publicationContentRevisionId}`
    : `legacy-${buildManagedBroadcastSemanticContentHash(row).slice(0, 32)}`;
  const baseKey = `managed-broadcast:send:${row.id}:occurrence:${occurrenceIndex}:target:${targetChatId}:content:${contentRevision}`;
  return attemptCount <= 1 ? baseKey : `${baseKey}:attempt:${attemptCount}`;
}

export function buildManagedBroadcastSemanticContentHash(row: PersistedManagedBroadcast): string {
  const hashString = (value: string): string => createHash('sha256').update(value).digest('hex');
  const semanticContent = {
    version: 1,
    entityType: row.entityType,
    text: row.text,
    textFormat: row.textFormat,
    buttons: row.buttons,
    buttonEnabled: row.buttonEnabled,
    buttonUrl: row.buttonUrl,
    buttonText: row.buttonText,
    imageEnabled: row.imageEnabled,
    imageBase64Hash: row.imageEnabled ? hashString(row.imageBase64) : null,
    imageMimeType: row.imageMimeType,
    imageFileName: row.imageFileName,
    mediaType: row.mediaType,
    mediaPayloadHash:
      row.mediaPayload === null
        ? null
        : hashString(stableStringifyManagedBroadcastActionKeyValue(row.mediaPayload)),
    mediaMimeType: row.mediaMimeType,
    mediaFileName: row.mediaFileName,
  };
  return hashString(stableStringifyManagedBroadcastActionKeyValue(semanticContent));
}

export function stableStringifyManagedBroadcastActionKeyValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map(stableStringifyManagedBroadcastActionKeyValue).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort((left, right) => left.localeCompare(right))
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringifyManagedBroadcastActionKeyValue(record[key])}`,
    )
    .join(',')}}`;
}
