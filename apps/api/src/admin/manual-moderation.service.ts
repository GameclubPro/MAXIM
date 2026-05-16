import { Injectable } from '@nestjs/common';
import { AdminService } from './admin.service';

@Injectable()
export class ManualModerationService {
  constructor(private readonly legacyAdminService: AdminService) {}

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
