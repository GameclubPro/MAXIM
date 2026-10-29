import { ConflictException } from '@nestjs/common';
import { ZodError } from 'zod';
import { migrateStopWordsPolicy } from '../moderation/stop-words/stop-words.policy';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { readStopWordsStorageStatus } from '../moderation/stop-words/stop-words-storage-status';
import { sanitizeStoredChatSettings } from './admin-chat-settings';

export function readEditableStopWordsPolicy(
  settings: Parameters<typeof migrateStopWordsPolicy>[0],
) {
  // FLAG: Legacy presentation normalization is read-only here. Never repair an unsupported
  // typed policy or enable a broader legacy policy because its stored reader is invalid.
  if (readStopWordsStorageStatus(settings) === 'invalid') return stopWordsPolicySchema.parse({});
  const source =
    settings.stopWordsPolicy == null
      ? (sanitizeStoredChatSettings({ ...settings }) as typeof settings)
      : settings;
  try {
    return migrateStopWordsPolicy(source);
  } catch (error: unknown) {
    throw new ConflictException({
      code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
      message: 'Список требует проверки перед редактированием.',
      revision: settings.stopWordsRevision ?? 0,
      fieldPaths:
        error instanceof ZodError
          ? [...new Set(error.issues.map((issue) => issue.path.join('.').slice(0, 160)))].slice(
              0,
              8,
            )
          : [],
    });
  }
}
