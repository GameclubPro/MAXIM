import { Injectable, Logger } from '@nestjs/common';
import type { ReportDetail } from '@maxim/contracts';
import { ReportViewService } from '../moderation/reports/report-view.service';
import { ManagedEntitiesService } from './managed-entities.service';

@Injectable()
export class AdminReportsService {
  private readonly logger = new Logger(AdminReportsService.name);
  constructor(
    private readonly reports: ReportViewService,
    private readonly profiles: ManagedEntitiesService,
  ) {}

  list(chatId: string, cursor?: unknown) {
    return this.reports.list(chatId, cursor);
  }

  async detail(chatId: string, id: string): Promise<ReportDetail> {
    return this.withProfiles(chatId, await this.reports.detail(chatId, id));
  }

  async dismiss(chatId: string, id: string, actorUserId: string): Promise<ReportDetail> {
    return this.withProfiles(chatId, await this.reports.dismiss(chatId, id, actorUserId));
  }

  private async withProfiles(chatId: string, report: ReportDetail): Promise<ReportDetail> {
    try {
      const userIds = [
        ...new Set([report.authorId, ...report.reporters.map((item) => item.userId)]),
      ];
      const profiles = await this.profiles.resolveChatUserProfiles(chatId, userIds);
      const author = profiles.get(report.authorId);
      return {
        ...report,
        authorName: author?.displayName?.trim() || report.authorName || null,
        authorProfileUrl: author?.profileUrl ?? null,
        authorProfileHandoffUrl: author?.profileHandoffUrl ?? null,
        reporters: report.reporters.map((item) => {
          const profile = profiles.get(item.userId);
          return {
            ...item,
            displayName: profile?.displayName?.trim() || item.displayName || null,
            profileUrl: profile?.profileUrl ?? null,
            profileHandoffUrl: profile?.profileHandoffUrl ?? null,
          };
        }),
      };
    } catch {
      // FLAG: Profile enrichment cannot hide a committed dismissal or the durable moderation result.
      this.logger.warn({ reportId: report.id }, 'Report profile enrichment unavailable');
      return report;
    }
  }
}
