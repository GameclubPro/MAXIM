import type { ManualModerationActionRequest } from '@maxim/contracts';
import { BadRequestException, type Logger } from '@nestjs/common';
import type { MaxClientService } from '../max/max-client.service';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  ModerationSanctionStateLockUnavailableError,
  type ModerationSanctionStateLeaseGuard,
} from '../moderation/moderation-sanction-state-lock.service';
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

export async function prepareManualBanFanoutTarget(params: {
  chatId: string;
  targetUserId: string;
  executionMode: ManualBanExecutionMode;
  leaseGuard: ModerationSanctionStateLeaseGuard;
  resolveTargetState(): Promise<'present' | 'absent' | 'protected' | null>;
  clearTerminalBanState(completedBefore: Date): Promise<void>;
}): Promise<'present' | 'absent' | 'protected'> {
  await params.leaseGuard.assertOwned();
  const probeStartedAt = new Date();
  const targetState = await params.resolveTargetState();
  if (!targetState) {
    throw new ModerationSanctionStateLockUnavailableError({
      chatId: params.chatId,
      userId: params.targetUserId,
    });
  }
  await params.leaseGuard.assertOwned();
  if (targetState === 'present' && params.executionMode === 'MAX_BLOCK') {
    // FLAG: Fresh presence permits retiring only confirmed BANs completed before the
    // probe. An uncertain effect or a concurrent newer BAN must retain its fence.
    await params.clearTerminalBanState(probeStartedAt);
  }
  return targetState;
}
