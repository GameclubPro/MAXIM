import {
  globalSpammerCandidateStatusSchema,
  globalSpammerReviewMetricsSchema,
  globalSpammerReviewQueueSchema,
  globalSpammerReviewRequestSchema,
  globalSpammerReviewResultSchema,
  globalSpammerUserDiagnosticsSchema,
  type GlobalSpammerCandidateStatus,
} from '@maxim/contracts';
import { BadRequestException, Injectable } from '@nestjs/common';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { AdminService } from './admin.service';

@Injectable()
export class ManualModerationService {
  constructor(
    private readonly legacyAdminService: AdminService,
    private readonly globalSpammerIntelligence: GlobalSpammerIntelligenceService,
  ) {}

  getChannelStats(
    ...args: Parameters<AdminService['getChannelStats']>
  ): ReturnType<AdminService['getChannelStats']> {
    return this.legacyAdminService.getChannelStats(...args);
  }

  getChannelActivityFeed(
    ...args: Parameters<AdminService['getChannelActivityFeed']>
  ): ReturnType<AdminService['getChannelActivityFeed']> {
    return this.legacyAdminService.getChannelActivityFeed(...args);
  }

  getChatActivityFeed(
    ...args: Parameters<AdminService['getChatActivityFeed']>
  ): ReturnType<AdminService['getChatActivityFeed']> {
    return this.legacyAdminService.getChatActivityFeed(...args);
  }

  getChatModerationFeed(
    ...args: Parameters<AdminService['getChatModerationFeed']>
  ): ReturnType<AdminService['getChatModerationFeed']> {
    return this.legacyAdminService.getChatModerationFeed(...args);
  }

  getChatParticipantsPage(
    ...args: Parameters<AdminService['getChatParticipantsPage']>
  ): ReturnType<AdminService['getChatParticipantsPage']> {
    return this.legacyAdminService.getChatParticipantsPage(...args);
  }

  updateChatParticipantImmunity(
    ...args: Parameters<AdminService['updateChatParticipantImmunity']>
  ): ReturnType<AdminService['updateChatParticipantImmunity']> {
    return this.legacyAdminService.updateChatParticipantImmunity(...args);
  }

  getEvents(...args: Parameters<AdminService['getEvents']>): ReturnType<AdminService['getEvents']> {
    return this.legacyAdminService.getEvents(...args);
  }

  getLogsDashboard(
    ...args: Parameters<AdminService['getLogsDashboard']>
  ): ReturnType<AdminService['getLogsDashboard']> {
    return this.legacyAdminService.getLogsDashboard(...args);
  }

  async getGlobalSpammerReviewQueue(chatId: string, user: AuthUser, query: unknown) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, null);
    const queryRecord =
      query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const rawStatus = typeof queryRecord.status === 'string' ? queryRecord.status.trim() : '';
    const status = this.parseGlobalSpammerCandidateStatus(rawStatus);
    const rawLimit =
      typeof queryRecord.limit === 'string' || typeof queryRecord.limit === 'number'
        ? Number(queryRecord.limit)
        : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 50;
    const response = await this.globalSpammerIntelligence.listReviewQueue({
      chatId,
      status,
      limit,
    });
    return globalSpammerReviewQueueSchema.parse(response);
  }

  async getGlobalSpammerReviewMetrics(chatId: string, user: AuthUser) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, null);
    const response = await this.globalSpammerIntelligence.getReviewMetrics({
      chatId,
    });
    return globalSpammerReviewMetricsSchema.parse(response);
  }

  async getGlobalSpammerUserDiagnostics(chatId: string, targetUserId: string, user: AuthUser) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, null);
    const response = await this.globalSpammerIntelligence.getUserDiagnostics({
      chatId,
      userId: targetUserId,
    });
    return globalSpammerUserDiagnosticsSchema.parse(response);
  }

  async reviewGlobalSpammerCandidate(
    chatId: string,
    targetUserId: string,
    user: AuthUser,
    body: unknown,
  ) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, null, {
      trafficClass: 'critical',
    });
    const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const reason =
      typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : undefined;
    const parsed = globalSpammerReviewRequestSchema.safeParse({
      action: typeof row.action === 'string' ? row.action.trim().toUpperCase() : row.action,
      ...(reason ? { reason } : {}),
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const response = await this.globalSpammerIntelligence.reviewCandidate({
      chatId,
      userId: targetUserId,
      reviewerUserId: user.userId,
      action: parsed.data.action,
      reason: parsed.data.reason ?? null,
    });
    return globalSpammerReviewResultSchema.parse(response);
  }

  private parseGlobalSpammerCandidateStatus(
    value: string,
  ): GlobalSpammerCandidateStatus | 'ALL' | undefined {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'ALL') {
      return normalized;
    }
    if (globalSpammerCandidateStatusSchema.safeParse(normalized).success) {
      return normalized as GlobalSpammerCandidateStatus;
    }
    return undefined;
  }

  applyManualModerationAction(
    ...args: Parameters<AdminService['applyManualModerationAction']>
  ): ReturnType<AdminService['applyManualModerationAction']> {
    return this.legacyAdminService.applyManualModerationAction(...args);
  }

  addAdmin(...args: Parameters<AdminService['addAdmin']>): ReturnType<AdminService['addAdmin']> {
    return this.legacyAdminService.addAdmin(...args);
  }

  removeAdmin(
    ...args: Parameters<AdminService['removeAdmin']>
  ): ReturnType<AdminService['removeAdmin']> {
    return this.legacyAdminService.removeAdmin(...args);
  }

  addDomain(...args: Parameters<AdminService['addDomain']>): ReturnType<AdminService['addDomain']> {
    return this.legacyAdminService.addDomain(...args);
  }

  getDomainAllowlist(
    ...args: Parameters<AdminService['getDomainAllowlist']>
  ): ReturnType<AdminService['getDomainAllowlist']> {
    return this.legacyAdminService.getDomainAllowlist(...args);
  }

  getDomainAllowlistDetails(
    ...args: Parameters<AdminService['getDomainAllowlistDetails']>
  ): ReturnType<AdminService['getDomainAllowlistDetails']> {
    return this.legacyAdminService.getDomainAllowlistDetails(...args);
  }

  removeDomain(
    ...args: Parameters<AdminService['removeDomain']>
  ): ReturnType<AdminService['removeDomain']> {
    return this.legacyAdminService.removeDomain(...args);
  }

  scheduleDomainRemoval(
    ...args: Parameters<AdminService['scheduleDomainRemoval']>
  ): ReturnType<AdminService['scheduleDomainRemoval']> {
    return this.legacyAdminService.scheduleDomainRemoval(...args);
  }

  processManualModerationFanoutJob(
    ...args: Parameters<AdminService['processManualModerationFanoutJob']>
  ): ReturnType<AdminService['processManualModerationFanoutJob']> {
    return this.legacyAdminService.processManualModerationFanoutJob(...args);
  }
}
