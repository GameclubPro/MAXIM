import type { VkParsingCapability } from '@maxim/contracts';

export function describeVkParsingCapability(capability: VkParsingCapability): string {
  if (capability.reasonCode === 'ACCESS_DENIED') {
    return 'Недостаточно прав администратора.';
  }

  if (capability.reasonCode === 'NOT_FOUND') {
    return 'Чат или канал не найден.';
  }

  return 'Импорт из VK временно недоступен. Попробуйте позже.';
}
