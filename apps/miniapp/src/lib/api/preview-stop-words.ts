import {
  StopWordsMatcher,
  normalizeStopWordsDomain,
  stopWordsPolicySchema,
  stopWordsPreviewRequestSchema,
  updateStopWordsRequestSchema,
} from '@maxim/contracts/settings';
import { ApiRequestError } from '../api-request-error';
import { readPreviewClock } from './preview-transport-runtime';
import { cloneJson, parseJsonBody } from './preview-transport-shared';
import type { PreviewState } from './preview-transport-state';

export function handlePreviewStopWords(
  state: PreviewState,
  tail: string[],
  url: URL,
  method: string,
  init?: RequestInit,
): unknown {
  if (tail[1] === 'status' && method === 'GET')
    return { revision: state.chatSettings.stopWordsRevision ?? 0, imageScanStatus: 'shadow' };
  if (tail.length === 1 && method === 'GET')
    return cloneJson({
      policy:
        state.stopWordsStorageStatus === 'invalid'
          ? stopWordsPolicySchema.parse({})
          : (state.chatSettings.stopWordsPolicy ?? stopWordsPolicySchema.parse({})),
      revision: state.chatSettings.stopWordsRevision ?? 0,
      settingsRevision: state.chatSettings.settingsRevision,
      storageStatus: state.stopWordsStorageStatus,
      imageScanStatus: 'shadow',
    });
  if (tail.length === 1 && method === 'PUT') {
    const failure = state.stopWordsWriteError;
    state.stopWordsWriteError = null;
    if (failure === 'network')
      throw new ApiRequestError(503, '{}', 'Сервис временно недоступен. Повторите позже.');
    if (failure === 'conflict') {
      state.chatSettings.stopWordsRevision = (state.chatSettings.stopWordsRevision ?? 0) + 1;
      throw new ApiRequestError(
        409,
        JSON.stringify({ code: 'STOP_WORDS_REVISION_CONFLICT' }),
        'Стоп-слова уже изменены. Обновите список.',
      );
    }
    const payload = updateStopWordsRequestSchema.parse(parseJsonBody(init));
    if (failure === 'review') state.stopWordsStorageStatus = 'invalid';
    if (state.stopWordsStorageStatus === 'invalid' && payload.replaceInvalidStorage !== true)
      throw new ApiRequestError(
        409,
        JSON.stringify({
          code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED',
          revision: state.chatSettings.stopWordsRevision ?? 0,
        }),
        'Проверьте сохранённый список перед заменой.',
      );
    if (payload.expectedRevision !== (state.chatSettings.stopWordsRevision ?? 0)) {
      if (
        (state.chatSettings.stopWordsRevision ?? 0) === payload.expectedRevision + 1 &&
        JSON.stringify(state.chatSettings.stopWordsPolicy) === JSON.stringify(payload.policy)
      )
        return cloneJson({
          policy: payload.policy,
          revision: state.chatSettings.stopWordsRevision,
          settingsRevision: state.chatSettings.settingsRevision,
          storageStatus: 'valid',
          imageScanStatus: 'shadow',
        });
      throw new ApiRequestError(
        409,
        JSON.stringify({ code: 'STOP_WORDS_REVISION_CONFLICT' }),
        'Стоп-слова уже изменены. Обновите список.',
      );
    }
    state.chatSettings = {
      ...state.chatSettings,
      stopWordsPolicy: payload.policy,
      stopWordsRevision: payload.expectedRevision + 1,
      settingsRevision: new Date(
        Math.max(Date.now(), Date.parse(state.chatSettings.settingsRevision ?? '') + 1 || 0),
      ).toISOString(),
    };
    state.stopWordsStorageStatus = 'valid';
    return cloneJson({
      policy: payload.policy,
      revision: payload.expectedRevision + 1,
      settingsRevision: state.chatSettings.settingsRevision,
      storageStatus: 'valid',
      imageScanStatus: 'shadow',
    });
  }
  if (tail[1] === 'preview' && method === 'POST') {
    const input = stopWordsPreviewRequestSchema.parse(parseJsonBody(init));
    const matcher = new StopWordsMatcher();
    return {
      enabled: input.policy.enabled,
      matches: matcher.detect({
        ...input,
        isLinkAllowlisted: (link) => {
          const host = normalizeStopWordsDomain(link);
          return state.chatDomains.some((entry) => {
            if (
              entry.removeAfterAt &&
              Date.parse(entry.removeAfterAt) <= readPreviewClock(state.clock).getTime()
            )
              return false;
            return entry.matchType === 'DOMAIN'
              ? host === entry.domain || host?.endsWith('.' + entry.domain) === true
              : link === entry.domain;
          });
        },
      }),
    };
  }

  throw new Error(`Preview transport does not implement ${method} ${url.pathname}`);
}
