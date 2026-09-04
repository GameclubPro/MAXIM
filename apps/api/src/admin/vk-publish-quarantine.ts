export const VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX = '[max.send_ambiguous]';
export const VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX =
  '[max.send_confirmed_persistence_pending]';

export function isVkMaxSendAmbiguous(lastError: string | null | undefined): boolean {
  return lastError?.trim().startsWith(VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true;
}

export function isVkMaxSendConfirmedPersistencePending(
  lastError: string | null | undefined,
): boolean {
  return lastError?.trim().startsWith(VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX) === true;
}
