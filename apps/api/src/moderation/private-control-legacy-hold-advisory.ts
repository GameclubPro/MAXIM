import type { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import type { PrivateSession } from './private-control.types';

type ChatAdminAuthority = {
  assertManagedEntityAdminAccess(chatId: string, userId: string, entityType: 'chat'): Promise<void>;
};

export type PrivateSettingsHandoffConfig = {
  title?: string;
  description?: string;
  buttonText?: string;
};

const defaultDescription =
  'Основные настройки и rich-сценарии больше не управляются inline-кнопками в боте.';
const heldNotice =
  'Автоматическая модерация для некоторых участников этого чата и их глобальная репутация приостановлены до проверки доказательств прежних действий. Восстановление прав ботов не снимает ограничение. Команды этих участников в группе тоже приостановлены. Управление настройками чата через личный диалог бота остаётся доступным.';
const unavailableNotice =
  'Статус ограничений автоматической модерации временно недоступен. Повторите запрос.';

export function create(
  adminService: ChatAdminAuthority,
  legacyHolds?: Pick<WebhookLegacyHoldService, 'hasChatHolds'>,
) {
  return async (
    actorUserId: string,
    session: Pick<PrivateSession, 'selectedChatId' | 'selectedEntityType'>,
    description = defaultDescription,
  ): Promise<string> => {
    if (
      !session.selectedChatId ||
      (session.selectedEntityType ?? 'chat') !== 'chat' ||
      !legacyHolds
    )
      return description;

    // FLAG: This advisory status is requested in a private CHAT-settings flow only.
    // Authorize the exact chat before reading metadata; never disclose identities or content.
    await adminService.assertManagedEntityAdminAccess(session.selectedChatId, actorUserId, 'chat');
    try {
      if (!(await legacyHolds.hasChatHolds(session.selectedChatId))) return description;
      return `${description}\n\n${heldNotice}`;
    } catch {
      return `${description}\n\n${unavailableNotice}`;
    }
  };
}
