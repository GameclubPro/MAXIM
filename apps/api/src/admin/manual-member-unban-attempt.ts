import {
  manualModerationActionResultSchema,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import { MAX_API_SOURCE_TAGS, type MaxClientService } from '../max/max-client.service';
import {
  ModerationSanctionStateChangedError,
  type ModerationSanctionStateLeaseGuard,
} from '../moderation/moderation-sanction-state-lock.service';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  ADMIN_ACTION_HEALTH_LANE,
  type AdminActionSource,
  type ManualModerationExecutionOptions,
} from './admin.service.support';

export async function attemptManualMemberUnban(
  context: {
    chatId: string;
    targetUserId: string;
    actorUserId: string;
    source: AdminActionSource;
    options: ManualModerationExecutionOptions;
    botId?: string;
  },
  maxClient: MaxClientService,
  leaseGuard: ModerationSanctionStateLeaseGuard,
  assertSanctionState: (params: {
    chatId: string;
    targetUserId: string;
    releaseAction: 'UNBAN';
    expectedSanctionEventId: string;
  }) => Promise<void>,
  assertBotAccess: (chatId: string, action: 'UNBAN', botId?: string) => Promise<void>,
  action: ManualModerationActionRequest['action'],
): Promise<ManualModerationActionResult | null> {
  const { chatId, targetUserId, actorUserId, source, options, botId } = context;
  if (options.attemptUnbanWithRemove !== true || action !== 'UNBAN') return null;
  const expectedSanctionEventId = options.expectedSanctionEventId?.trim();
  if (
    options.entityType === ChatEntityType.CHANNEL ||
    source !== 'group_command' ||
    !expectedSanctionEventId
  ) {
    throw new BadRequestException('Действие доступно только для выбранной санкции в чате.');
  }
  const readTargetAccess = () =>
    maxClient.getChatMemberAccess(chatId, targetUserId, {
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
      ...(botId ? { botId } : {}),
    });
  await leaseGuard.assertOwned();
  if (await readTargetAccess()) return null;
  await assertBotAccess(chatId, 'UNBAN', botId);
  // FLAG: DELETE block=false is an unverified unban attempt. Its success must
  // not release the sanction fence, clear BAN state, or record MANUAL_UNBAN.
  await maxClient.attemptUnbanMember(chatId, targetUserId, {
    immediate: true,
    trafficClass: 'critical',
    actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
    sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
    idempotencyKey: `manual-unban-attempt:${expectedSanctionEventId}`,
    ledgerContext: {
      operation: 'MANUAL_UNBAN_ATTEMPT',
      sanctionEventId: expectedSanctionEventId,
      actorUserId,
    },
    beforeImmediateMemberMutation: async () => {
      await leaseGuard.assertOwned();
      await assertSanctionState({
        chatId,
        targetUserId,
        releaseAction: 'UNBAN',
        expectedSanctionEventId,
      });
      if (await readTargetAccess()) throw new ModerationSanctionStateChangedError();
      await leaseGuard.assertOwned();
    },
    ...(botId ? { botId } : {}),
  });
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: 'UNBAN',
    userId: targetUserId,
    muteDurationHours: null,
    muteExpiresAt: null,
    message: 'Запрос выполнен. Проверьте вход в чат.',
  });
}
