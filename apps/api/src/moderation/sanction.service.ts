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
    const manualReleaseResetAt = await this.getManualReleaseResetAt(chatId, userId);

    const warningsCount = await this.prisma.violation.count({
      where: {
        chatId,
        userId,
        ...(manualReleaseResetAt
          ? {
              createdAt: {
                gt: manualReleaseResetAt,
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
      manualReleaseResetAt && manualReleaseResetAt.getTime() > baseSince.getTime()
        ? manualReleaseResetAt
        : baseSince;
    const recentMute = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        action: SanctionAction.MUTE,
        createdAt: {
          gte: since,
        },
      },
      select: {
        id: true,
      },
    });

    return recentMute ? SanctionAction.BAN : SanctionAction.MUTE;
  }

  private async getManualReleaseResetAt(chatId: string, userId: string): Promise<Date | null> {
    const latestManualRelease = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        ruleCode: {
          in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        createdAt: true,
      },
    });

    return latestManualRelease?.createdAt ?? null;
  }
}
