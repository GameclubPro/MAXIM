import type { ZodIssue } from 'zod';
import type { ChatSettingsFieldPath } from '../../features/network-settings/field-model';

export type StopWordsFieldPath = Extract<ChatSettingsFieldPath, `stopWordsPolicy.${string}`>;
export type StopWordsFocusTarget = {
  field: StopWordsFieldPath;
  path: readonly PropertyKey[];
};
export type StopWordsFocusRequest = StopWordsFocusTarget & { requestId: number };
export type StopWordsValidationFeedback = {
  errors: Partial<Record<StopWordsFieldPath, string>>;
  first: StopWordsFocusTarget | null;
  moduleError: string | null;
};

const scalarFields = new Set<StopWordsFieldPath>([
  'stopWordsPolicy.enabled',
  'stopWordsPolicy.imageScanEnabled',
  'stopWordsPolicy.sanctions.botMessageEnabled',
  'stopWordsPolicy.sanctions.botMessageText',
  'stopWordsPolicy.sanctions.warnEnabled',
  'stopWordsPolicy.sanctions.warnMessageText',
  'stopWordsPolicy.sanctions.muteEnabled',
  'stopWordsPolicy.sanctions.muteDurationHours',
  'stopWordsPolicy.sanctions.banEnabled',
  'stopWordsPolicy.sanctions.botButtonEnabled',
  'stopWordsPolicy.sanctions.adminContactButtonEnabled',
  'stopWordsPolicy.sanctions.adminContactButtonUrl',
  'stopWordsPolicy.sanctions.rulesButtonEnabled',
]);
const fallback = 'Проверьте настройки стоп-слов.';

function owningField(path: readonly PropertyKey[]): StopWordsFieldPath | null {
  const key = path.join('.');
  if (scalarFields.has(key as StopWordsFieldPath)) return key as StopWordsFieldPath;
  const indexed = (offset: number, leaves: readonly string[]) =>
    path.length === offset ||
    (typeof path[offset] === 'number' &&
      Number.isSafeInteger(path[offset]) &&
      path[offset] >= 0 &&
      (path.length === offset + 1 ||
        (path.length === offset + 2 && leaves.includes(String(path[offset + 1])))));
  if (path[1] === 'rules' && indexed(2, ['id', 'value', 'kind', 'enabled', 'matchMode']))
    return 'stopWordsPolicy.rules';
  if (path[1] === 'domains' && indexed(2, [])) return 'stopWordsPolicy.domains';
  if (path[1] === 'sanctions' && path[2] === 'botButtons' && indexed(3, ['text', 'url']))
    return 'stopWordsPolicy.sanctions.botButtons';
  if (
    path[1] === 'sanctions' &&
    path[2] === 'media' &&
    (path[3] === 'explanation' || path[3] === 'warning') &&
    (path.length === 4 ||
      (path.length === 5 && ['base64', 'mimeType', 'fileName'].includes(String(path[4]))))
  )
    return `stopWordsPolicy.sanctions.media.${path[3]}`;
  return null;
}

export function mapStopWordsValidationIssues(
  issues: readonly Pick<ZodIssue, 'path' | 'message'>[],
): StopWordsValidationFeedback {
  const result: StopWordsValidationFeedback = { errors: {}, first: null, moduleError: null };
  for (const issue of issues) {
    const path = issue?.path;
    if (!Array.isArray(path)) {
      result.moduleError ??= fallback;
      continue;
    }
    if (path[0] !== 'stopWordsPolicy') continue;
    if (
      path.some((part) => typeof part !== 'string' && typeof part !== 'number') ||
      typeof issue.message !== 'string' ||
      !issue.message.trim()
    ) {
      result.moduleError ??= fallback;
      continue;
    }
    const field = owningField(path);
    const message = issue.message.trim();
    if (!field) {
      result.moduleError ??= message;
      continue;
    }
    result.errors[field] ??= message;
    result.first ??= { field, path: [...path] };
  }
  return result;
}
