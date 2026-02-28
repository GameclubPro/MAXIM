import { Injectable } from '@nestjs/common';
import { SanctionAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SanctionService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveAction(params: {
    chatId: string;
    userId: string;
    warnThreshold: number;
    repeatBanWindowDays: number;
  }): Promise<SanctionAction> {
    const { chatId, userId, warnThreshold, repeatBanWindowDays } = params;

    const warningsCount = await this.prisma.violation.count({
      where: {
        chatId,
        userId,
      },
    });

    if (warningsCount === 0 || warningsCount % warnThreshold !== 0) {
      return SanctionAction.WARN;
    }

    const since = new Date(Date.now() - repeatBanWindowDays * 24 * 60 * 60 * 1000);
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
}
