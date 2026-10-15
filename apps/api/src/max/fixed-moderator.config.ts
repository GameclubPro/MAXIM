import type { ConfigService } from '@nestjs/config';

export function isFixedModeratorSelectionEnabled(
  config: ConfigService | undefined,
  chatId: string,
): boolean {
  if (config?.get<boolean>('MAX_FIXED_MODERATOR_SELECTION_ENABLED') !== true) return false;
  const ids = (config.get<string>('MAX_FIXED_MODERATOR_SELECTION_ENTITY_IDS') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length === 0 || ids.includes(chatId);
}
