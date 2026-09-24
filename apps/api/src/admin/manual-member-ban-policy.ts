import type { ManualModerationActionRequest } from '@maxim/contracts';
import { BadRequestException, type Logger } from '@nestjs/common';
import type { MaxClientService } from '../max/max-client.service';
import { ChatEntityType } from '../prisma/prisma-client';
import { ADMIN_ACTION_HEALTH_LANE, type ManualBanExecutionMode } from './admin.service.support';

export function assertChannelMemberBanScope(
  entityType: ChatEntityType | undefined,
  request: ManualModerationActionRequest,
): void {
  // FLAG: A channel ban never inherits all-chat fanout or message-moderation actions.
  if (
    entityType === ChatEntityType.CHANNEL &&
    (request.action !== 'BAN' || request.scope !== 'current_chat')
  ) {
    throw new BadRequestException('В канале доступна только блокировка в текущем канале.');
  }
}

export function describeManualBanResult(mode: ManualBanExecutionMode, isChannel: boolean): string {
  if (mode !== 'MAX_REMOVE_ONLY') return 'Бан включён.';
  return isChannel
    ? 'Участник удалён из канала. MAX не поддерживает блокировку без ссылки на канал.'
    : 'Участник удалён из чата.';
}

export async function resolveManualMemberBanMode(
  maxClient: MaxClientService,
  logger: Pick<Logger, 'debug'>,
  chatId: string,
  botId?: string,
): Promise<ManualBanExecutionMode> {
  if (typeof maxClient.getChatSnapshot !== 'function') return 'MAX_BLOCK';
  try {
    const snapshot = await maxClient.getChatSnapshot(chatId, {
      trafficClass: 'critical',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      ...(botId ? { botId } : {}),
    });
    if (snapshot.isPublic === false && !snapshot.link) return 'MAX_REMOVE_ONLY';
  } catch (error: unknown) {
    logger.debug(
      { chatId, err: error instanceof Error ? error.message : String(error) },
      'Failed to resolve chat visibility before manual ban',
    );
  }
  return 'MAX_BLOCK';
}
