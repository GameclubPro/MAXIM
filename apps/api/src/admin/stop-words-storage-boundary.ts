import { ConflictException } from '@nestjs/common';
import type { StopWordsStorageStatus } from '@maxim/contracts/settings';

export function assertStopWordsStorageEditable(state: {
  revision: number;
  storageStatus?: StopWordsStorageStatus;
}): void {
  // FLAG: A disabled presentation of invalid storage is not a policy source. Only an
  // explicit standalone replacement may author it; partial edits and copies must stop.
  if (state.storageStatus === 'valid' || state.storageStatus === 'legacy') return;
  throw new ConflictException({
    code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
    message: 'Список требует проверки перед редактированием.',
    revision: state.revision,
    fieldPaths: [],
  });
}
