import { GoneException } from '@nestjs/common';

export const LEGACY_PUBLICATION_WRITES_DISABLED_CODE = 'LEGACY_PUBLICATION_WRITES_DISABLED';

export function throwLegacyPublicationWritesDisabled(): never {
  throw new GoneException({
    code: LEGACY_PUBLICATION_WRITES_DISABLED_CODE,
    message: 'Посты и автопостинг теперь в боте Публик: https://max.ru/se14088825_bot',
  });
}
