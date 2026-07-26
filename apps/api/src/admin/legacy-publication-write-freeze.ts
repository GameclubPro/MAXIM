import { GoneException } from '@nestjs/common';

export const LEGACY_PUBLICATION_WRITES_DISABLED_CODE = 'LEGACY_PUBLICATION_WRITES_DISABLED';

export function throwLegacyPublicationWritesDisabled(): never {
  throw new GoneException({
    code: LEGACY_PUBLICATION_WRITES_DISABLED_CODE,
    message:
      'Старый автопостинг и рассылки доступны только для просмотра и остановки. Создавайте новые отправки в разделе «Публикации».',
  });
}
