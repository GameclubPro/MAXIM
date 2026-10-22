import type { MiniappProfile } from '@maxim/contracts/publisher';

export function majorNetworksEnabled(
  mode: unknown,
  profile: MiniappProfile,
  userId: string,
  testUserIds: ReadonlySet<string>,
): boolean {
  if (profile !== 'moderation') return false;
  return mode === 'on' || (mode === 'test' && testUserIds.has(userId.trim()));
}
