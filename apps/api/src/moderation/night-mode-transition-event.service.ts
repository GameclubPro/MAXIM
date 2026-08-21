import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { formatNightModeMinutesAsTime } from './night-mode-transition-notice.util';

export type NightModeTransitionEventRuleCode = 'NIGHT_MODE_CLOSE_NOTICE' | 'NIGHT_MODE_OPEN_NOTICE';

export type NightModeTransitionEventParams = {
  chatId: string;
  messageId: string | null;
  botId?: string | null;
  ruleCode: NightModeTransitionEventRuleCode;
  sessionKey: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
};

export type EnsuredNightModeTransitionEvent = {
  id: string;
};

@Injectable()
export class NightModeTransitionEventService {
  private readonly ownBotUserId: string | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotContextService?: MaxBotContextService,
  ) {
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
  }

  async createTransitionEvent(params: NightModeTransitionEventParams): Promise<void> {
    await this.prisma.moderationEvent.create({
      data: this.buildTransitionEventData(params),
    });
  }

  async ensureTransitionEvent(
    params: NightModeTransitionEventParams & { messageId: string; botId: string },
  ): Promise<EnsuredNightModeTransitionEvent> {
    const chatId = params.chatId.trim();
    const messageId = params.messageId.trim();
    const botId = params.botId.trim();
    const sessionKey = params.sessionKey.trim();
    if (!chatId || !messageId || !botId || !sessionKey) {
      throw new Error('Exact night mode transition event identity is required');
    }

    const lockIdentity = [
      'night-mode-transition-event:v1',
      chatId,
      messageId,
      botId,
      params.ruleCode,
      sessionKey,
    ].join('\u001f');

    // FLAG: The Redis transition lease can expire between the existence read and event insert.
    // This database lock serializes the exact identity even when two former lock owners overlap.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0::BIGINT))
      `);
      const existing = await tx.moderationEvent.findFirst({
        where: {
          chatId,
          messageId,
          botId,
          ruleCode: params.ruleCode,
          metadata: {
            path: ['sessionKey'],
            equals: sessionKey,
          } satisfies Prisma.JsonFilter,
        },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        return existing;
      }

      return tx.moderationEvent.create({
        data: this.buildTransitionEventData({
          ...params,
          chatId,
          messageId,
          botId,
          sessionKey,
        }),
        select: { id: true },
      });
    });
  }

  private buildTransitionEventData(
    params: NightModeTransitionEventParams,
  ): Prisma.ModerationEventUncheckedCreateInput {
    const botId = typeof params.botId === 'string' ? params.botId.trim() : '';
    return this.withBotModerationEventData({
      chatId: params.chatId,
      userId: this.ownBotUserId ?? 'bot',
      messageId: params.messageId,
      ...(botId ? { botId } : {}),
      eventType: EventType.SYSTEM,
      ruleCode: params.ruleCode,
      action: SanctionAction.NONE,
      maskedExcerpt: null,
      score: 0.1,
      operator: Operator.BOT,
      metadata: {
        reason: this.buildReason(params.ruleCode),
        sessionKey: params.sessionKey,
        nightModeTimezone: params.timezone,
        nightModeStartTime: formatNightModeMinutesAsTime(params.startMinutes),
        nightModeEndTime: formatNightModeMinutesAsTime(params.endMinutes),
      },
    });
  }

  private withBotModerationEventData(
    data: Prisma.ModerationEventUncheckedCreateInput,
  ): Prisma.ModerationEventUncheckedCreateInput {
    if (data.operator !== Operator.BOT) {
      return data;
    }

    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    if (!activeBotId || typeof data.botId === 'string') {
      return data;
    }

    return {
      ...data,
      botId: activeBotId,
    };
  }

  private buildReason(ruleCode: NightModeTransitionEventRuleCode): string {
    return ruleCode === 'NIGHT_MODE_CLOSE_NOTICE'
      ? 'Night mode close notice sent by schedule'
      : 'Night mode open notice sent by schedule';
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }
}
