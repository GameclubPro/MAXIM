import {
  stopWordsMediaSchema,
  stopWordsPolicySchema,
  type StopWordsStorageStatus,
} from '@maxim/contracts/settings';

export function readStopWordsStorageStatus(settings: {
  stopWordsPolicy?: unknown;
  stopWordsMedia?: unknown;
}): StopWordsStorageStatus {
  if (settings.stopWordsPolicy == null) return 'legacy';
  return stopWordsPolicySchema.safeParse(settings.stopWordsPolicy).success &&
    (settings.stopWordsMedia == null ||
      stopWordsMediaSchema.safeParse(settings.stopWordsMedia).success)
    ? 'valid'
    : 'invalid';
}
