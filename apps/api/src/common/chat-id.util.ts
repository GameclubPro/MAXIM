export function parseChatIdAsBigInt(chatId: string): bigint | null {
  if (typeof chatId !== 'string') {
    return null;
  }

  const normalized = chatId.trim();
  if (!/^-?\d+$/u.test(normalized)) {
    return null;
  }

  try {
    return BigInt(normalized);
  } catch {
    return null;
  }
}

export function isPrivateDirectChatId(chatId: string): boolean {
  const numericChatId = parseChatIdAsBigInt(chatId);
  return numericChatId !== null && numericChatId > 0n;
}
