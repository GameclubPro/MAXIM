import { BadRequestException } from '@nestjs/common';
import { MaxMediaUploadValidationError } from '../max/max-media-upload-validation';

export function extractPrivateControlUserErrorDetails(error: unknown): string | null {
  if (error instanceof MaxMediaUploadValidationError) {
    return error.publicMessage;
  }

  if (!(error instanceof BadRequestException)) {
    return null;
  }

  return normalizePrivateControlErrorMessage(normalizeBadRequestResponse(error.getResponse()));
}

function normalizePrivateControlErrorMessage(message: string | null): string | null {
  const normalized = message?.trim() ?? '';
  return !normalized || isTechnicalPrivateControlErrorMessage(normalized) ? null : normalized;
}

function isTechnicalPrivateControlErrorMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    /^request failed with status code \d{3}$/u.test(normalized) ||
    /^timeout of \d+ms exceeded$/u.test(normalized) ||
    normalized.includes('axioserror') ||
    normalized.includes('max api')
  );
}

function normalizeBadRequestResponse(response: unknown): string | null {
  const messages = collectBadRequestMessages(response);
  if (messages.length > 0) {
    return Array.from(new Set(messages)).join('; ');
  }

  if (
    response &&
    typeof response === 'object' &&
    typeof (response as Record<string, unknown>).error === 'string'
  ) {
    const errorLabel = ((response as Record<string, unknown>).error as string).trim();
    if (errorLabel.length > 0) {
      return errorLabel;
    }
  }

  try {
    return JSON.stringify(response);
  } catch {
    return null;
  }
}

function collectBadRequestMessages(response: unknown): string[] {
  if (typeof response === 'string') {
    const normalized = response.trim();
    return normalized.length > 0 ? [normalized] : [];
  }

  if (Array.isArray(response)) {
    return response.flatMap((item) => collectBadRequestMessages(item));
  }

  if (!response || typeof response !== 'object') {
    return [];
  }

  const row = response as Record<string, unknown>;
  const messages: string[] = [];
  const directMessage = row.message;

  if (typeof directMessage === 'string' && directMessage.trim().length > 0) {
    messages.push(directMessage.trim());
  } else if (Array.isArray(directMessage)) {
    messages.push(...directMessage.flatMap((item) => collectBadRequestMessages(item)));
  }

  const zodErrors = row._errors;
  if (Array.isArray(zodErrors)) {
    messages.push(
      ...zodErrors
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  for (const [key, value] of Object.entries(row)) {
    if (key === 'message' || key === 'error' || key === '_errors') {
      continue;
    }
    if (!value || (typeof value !== 'object' && !Array.isArray(value))) {
      continue;
    }
    messages.push(...collectBadRequestMessages(value));
  }

  return messages;
}
