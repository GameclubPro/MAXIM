import { GoneException } from '@nestjs/common';
import type { ManagedBroadcastService } from '../admin/managed-broadcast.service';
import {
  LEGACY_PUBLICATION_WRITES_DISABLED_CODE,
  throwLegacyPublicationWritesDisabled,
} from '../admin/legacy-publication-write-freeze';

const LEGACY_PUBLICATION_PRIVATE_CONTROL_MESSAGE =
  'Старый автопостинг отключён. Создавайте новые отправки в разделе «Публикации».';

export function requireService(
  service: ManagedBroadcastService | undefined,
): ManagedBroadcastService {
  if (!service) throwLegacyPublicationWritesDisabled();
  return service;
}

export function resolveWriteErrorMessage(error: unknown, badRequestDetails: string | null): string {
  if (error instanceof GoneException) {
    const response = error.getResponse();
    if (
      response !== null &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      (response as Record<string, unknown>).code === LEGACY_PUBLICATION_WRITES_DISABLED_CODE
    ) {
      return LEGACY_PUBLICATION_PRIVATE_CONTROL_MESSAGE;
    }
  }
  return badRequestDetails ?? 'Автопостинг недоступен. Попробуйте ещё раз через несколько секунд.';
}
