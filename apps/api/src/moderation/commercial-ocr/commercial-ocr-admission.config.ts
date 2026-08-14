import type { ConfigService } from '@nestjs/config';

export const COMMERCIAL_OCR_DEFAULT_RESERVATION_TTL_MS = 10 * 60_000;

export function resolveCommercialOcrReservationTtlMs(
  configService?: Pick<ConfigService, 'get'>,
): number {
  const configured = Number(configService?.get('COMMERCIAL_OCR_RESERVATION_TTL_MS'));
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : COMMERCIAL_OCR_DEFAULT_RESERVATION_TTL_MS;
}
