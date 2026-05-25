const VK_PARSING_ALLOWED_USER_IDS = new Set(['183470701', '98315271']);

export function canUseVkParsing(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && VK_PARSING_ALLOWED_USER_IDS.has(userId.trim());
}
