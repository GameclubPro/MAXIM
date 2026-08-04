import type { Logger } from '@nestjs/common';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import type { MaxClientService } from '../max/max-client.service';
import { withModerationReleaseButton } from '../moderation/moderation-release-callback.util';
import type { AdminActionSource } from './admin.service.support';

export function formatManualModerationUserLabel(
  displayName: string | null | undefined,
  userId: string,
): string {
  const safeName = escapeMarkdownPlainText(
    normalizeMaxUserDisplayName(displayName, userId) ?? 'Пользователь',
  );
  const normalizedUserId = userId.trim();
  return normalizedUserId
    ? `[${safeName}](max://user/${encodeURIComponent(normalizedUserId)})`
    : `**${safeName}**`;
}

export async function sendManualBanChatNotice(
  maxClient: MaxClientService,
  logger: Pick<Logger, 'warn'>,
  params: {
    chatId: string;
    targetUserId: string;
    targetDisplayName?: string | null;
    source: AdminActionSource;
    removedOnly: boolean;
    botId?: string;
  },
): Promise<void> {
  if (params.source === 'group_command' || typeof maxClient.sendMessage !== 'function') {
    return;
  }

  const userMention = formatManualModerationUserLabel(
    params.targetDisplayName,
    params.targetUserId,
  );
  const text = params.removedOnly
    ? `Участник ${userMention} удалён из чата.`
    : `Для участника ${userMention} включён бан.`;

  try {
    await maxClient.sendMessage(
      params.chatId,
      text,
      withModerationReleaseButton(
        { textFormat: 'markdown' },
        {
          action: 'UNBAN',
          chatId: params.chatId,
          targetUserId: params.targetUserId,
        },
      ),
      {
        immediate: true,
        ...(params.botId ? { botId: params.botId } : {}),
      },
    );
  } catch (error: unknown) {
    logger.warn(
      {
        chatId: params.chatId,
        userId: params.targetUserId,
        source: params.source,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to send manual ban chat notice',
    );
  }
}

function escapeMarkdownPlainText(value: string): string {
  return value.replace(/([\\`*_[\]()~+#])/g, '\\$1');
}
