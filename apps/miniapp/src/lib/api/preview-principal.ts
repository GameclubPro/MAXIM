import type { ApiTransport } from './transport';

const previewPrincipalUserIds = new WeakMap<ApiTransport, string>();

export function markPreviewApiPrincipal(api: ApiTransport, userId: string): ApiTransport {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error('Preview API principal user id is required.');
  }

  previewPrincipalUserIds.set(api, normalizedUserId);
  return api;
}

export function getPreviewApiPrincipalUserId(api: ApiTransport): string | null {
  return previewPrincipalUserIds.get(api) ?? null;
}
