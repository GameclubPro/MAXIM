import type { Prisma } from '../prisma/prisma-client';

export function readLowerString(value: unknown): string | null {
  const normalized = readTrimmedString(value);
  return normalized ? normalized.toLowerCase() : null;
}

export function readRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readObjectPayload(value: Prisma.JsonValue): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
