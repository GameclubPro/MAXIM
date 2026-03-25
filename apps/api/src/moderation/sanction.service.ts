import { Injectable } from '@nestjs/common';
import { SanctionAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_REPEAT_BAN_WINDOW_DAYS = 7;

@Injectable()
export class SanctionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveAction(params: {
    chatId: string;
    userId: string;
    warnThreshold: number;
  }): Promise<SanctionAction> {
    const { chatId, userId, warnThreshold } = params;
    const manualUnbanResetAt = await this.getManualUnbanResetAt(chatId, userId);

    const warningsCount = await this.prisma.violation.count({
      where: {
        chatId,
        userId,
        ...(manualUnbanResetAt
          ? {
              createdAt: {
                gt: manualUnbanResetAt,
              },
            }
          : {}),
      },
    });

    if (warningsCount === 0 || warningsCount % warnThreshold !== 0) {
      return SanctionAction.WARN;
    }

    const baseSince = new Date(Date.now() - DEFAULT_REPEAT_BAN_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const since =
      manualUnbanResetAt && manualUnbanResetAt.getTime() > baseSince.getTime()
        ? manualUnbanResetAt
        : baseSince;
    const recentKick = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        action: SanctionAction.KICK,
        createdAt: {
          gte: since,
        },
      },
      select: {
        id: true,
      },
    });

    return recentKick ? SanctionAction.BAN : SanctionAction.KICK;
  }

  private async getManualUnbanResetAt(chatId: string, userId: string): Promise<Date | null> {
    const latestManualUnban = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        ruleCode: 'MANUAL_UNBAN',
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        createdAt: true,
      },
    });

    return latestManualUnban?.createdAt ?? null;
  }
}
