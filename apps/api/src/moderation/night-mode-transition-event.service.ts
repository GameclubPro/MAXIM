import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventType, Operator, SanctionAction, type Prisma } from '../prisma/prisma-client';
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
    const botId = typeof params.botId === 'string' ? params.botId.trim() : '';
    await this.prisma.moderationEvent.create({
      data: this.withBotModerationEventData({
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
      }),
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
