import type { ManagedEntityHeader } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { resolvePresentableManagedEntityTitle } from '../admin/admin-legacy-utils';

export const KARAVAN_ALLOWLIST_CHAT_TITLE_FALLBACK = 'Выбранный чат';

type KaravanAllowlistChatHeaderLoader = (
  chatId: string,
  user: AuthUser,
) => Promise<Pick<ManagedEntityHeader, 'title'>>;

export function isPresentableKaravanAllowlistChatTitle(
  chatId: string,
  title: string | null | undefined,
): boolean {
  return resolvePresentableManagedEntityTitle(chatId, title) !== null;
}

export function formatKaravanAllowlistChatTitle(
  chatId: string,
  title: string | null | undefined,
): string {
  return (
    resolvePresentableManagedEntityTitle(chatId, title) ?? KARAVAN_ALLOWLIST_CHAT_TITLE_FALLBACK
  );
}

export async function resolveKaravanAllowlistChatTitle(params: {
  chatId: string;
  user: AuthUser;
  loadHeader: KaravanAllowlistChatHeaderLoader;
}): Promise<string> {
  const chatId = params.chatId.trim();
  try {
    const header = await params.loadHeader(chatId, params.user);
    const title = resolvePresentableManagedEntityTitle(chatId, header.title);
    if (title) {
      return title;
    }
  } catch {
    // The destination title is presentation metadata; a generic label keeps the handoff usable.
  }

  const launchContextTitle =
    params.user.chatId?.trim() === chatId
      ? resolvePresentableManagedEntityTitle(chatId, params.user.chatTitle)
      : null;
  return launchContextTitle ?? KARAVAN_ALLOWLIST_CHAT_TITLE_FALLBACK;
}
