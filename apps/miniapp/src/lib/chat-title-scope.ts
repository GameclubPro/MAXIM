let confirmedScope: { userId: string; profile: 'moderation' | 'publisher' } | null = null;

export function setChatTitleScope(userId: string, profile: 'moderation' | 'publisher'): void {
  confirmedScope = { userId, profile };
}

export function getChatTitleScope() {
  return confirmedScope;
}
