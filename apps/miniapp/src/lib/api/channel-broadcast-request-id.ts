export function createBroadcastRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/gu, '');
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}
