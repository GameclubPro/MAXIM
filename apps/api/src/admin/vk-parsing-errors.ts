import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

export type VkParsingErrorClass = {
  code: string;
  message: string;
  retryable: boolean;
};

export class VkApiRequestError extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'VkApiRequestError';
  }
}

export function classifyVkParsingSyncError(error: unknown): VkParsingErrorClass {
  if (error instanceof VkApiRequestError) {
    return {
      code: `vk_api.${error.code}`,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (isPrismaTransactionTimeout(error)) {
    return {
      code: 'db.transaction_timeout',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }
  if (isPrismaUniqueConflict(error)) {
    return {
      code: 'db.conflict',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }

  return {
    code: 'unknown',
    message: formatVkParsingError(error),
    retryable: true,
  };
}

export function classifyVkParsingMediaPreflightError(error: unknown): VkParsingErrorClass {
  if (isPrismaUniqueConflict(error)) {
    return {
      code: 'media_preflight.db_conflict',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }
  if (isPrismaTransactionTimeout(error)) {
    return {
      code: 'media_preflight.db_transaction_timeout',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }

  return {
    code: 'media_preflight.unknown',
    message: formatVkParsingError(error),
    retryable: true,
  };
}

export function classifyVkParsingPublishError(error: unknown): VkParsingErrorClass {
  if (isPrismaTransactionTimeout(error)) {
    return {
      code: 'db.transaction_timeout',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }
  if (isPrismaUniqueConflict(error)) {
    return {
      code: 'db.conflict',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }
  if (isMaxAttachmentNotReadyError(error)) {
    return {
      code: 'max.upload_not_ready',
      message: formatVkParsingError(error),
      retryable: true,
    };
  }

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (typeof status === 'number') {
    return {
      code: `max.api_${status}`,
      message: formatVkParsingError(error),
      retryable: status === 429 || status >= 500,
    };
  }

  const message = formatVkParsingError(error);
  const normalized = message.toLowerCase();
  if (normalized.includes('rate limit') || normalized.includes('too many requests')) {
    return {
      code: 'max.rate_limit',
      message,
      retryable: true,
    };
  }
  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('terminated') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('network')
  ) {
    return {
      code: 'media.transient',
      message,
      retryable: true,
    };
  }
  if (
    normalized.includes('фото') ||
    normalized.includes('image') ||
    normalized.includes('attachment') ||
    normalized.includes('vk вернул')
  ) {
    return {
      code: 'media.publish_preflight',
      message,
      retryable: false,
    };
  }

  if (error instanceof BadRequestException) {
    return {
      code: 'publish.validation',
      message,
      retryable: false,
    };
  }

  return {
    code: 'publish.unknown',
    message,
    retryable: true,
  };
}

export function formatVkParsingClassifiedErrorMessage(error: VkParsingErrorClass): string {
  return `[${error.code}] ${error.message}`.slice(0, 500);
}

export function isPrismaUniqueConflict(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'P2002';
}

export function isPrismaTransactionTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (code === 'P2028') {
    return true;
  }

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('transaction') && message.includes('timeout');
}

export function isMaxAttachmentNotReadyError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (typeof status === 'number' && status !== 400) {
    return false;
  }

  const responseData = (error as { response?: { data?: unknown } })?.response?.data;
  const normalized = JSON.stringify(responseData ?? error ?? '').toLowerCase();
  return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
}

export function formatVkParsingError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim().slice(0, 500);
  }

  return 'Неизвестная ошибка VK-парсинга.';
}
