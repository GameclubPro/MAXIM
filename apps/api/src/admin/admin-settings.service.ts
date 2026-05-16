import { Injectable } from '@nestjs/common';
import { AdminService } from './admin.service';

@Injectable()
export class AdminSettingsService {
  constructor(private readonly legacyAdminService: AdminService) {}

  getSettings(
    ...args: Parameters<AdminService['getSettings']>
  ): ReturnType<AdminService['getSettings']> {
    return this.legacyAdminService.getSettings(...args);
  }

  getChatSettingsScreen(
    ...args: Parameters<AdminService['getChatSettingsScreen']>
  ): ReturnType<AdminService['getChatSettingsScreen']> {
    return this.legacyAdminService.getChatSettingsScreen(...args);
  }

  resolveRequiredSubscriptionChannel(
    ...args: Parameters<AdminService['resolveRequiredSubscriptionChannel']>
  ): ReturnType<AdminService['resolveRequiredSubscriptionChannel']> {
    return this.legacyAdminService.resolveRequiredSubscriptionChannel(...args);
  }

  updateSettings(
    ...args: Parameters<AdminService['updateSettings']>
  ): ReturnType<AdminService['updateSettings']> {
    return this.legacyAdminService.updateSettings(...args);
  }

  getRules(...args: Parameters<AdminService['getRules']>): ReturnType<AdminService['getRules']> {
    return this.legacyAdminService.getRules(...args);
  }

  updateRules(
    ...args: Parameters<AdminService['updateRules']>
  ): ReturnType<AdminService['updateRules']> {
    return this.legacyAdminService.updateRules(...args);
  }

  publishRules(
    ...args: Parameters<AdminService['publishRules']>
  ): ReturnType<AdminService['publishRules']> {
    return this.legacyAdminService.publishRules(...args);
  }

  resetPublishedRules(
    ...args: Parameters<AdminService['resetPublishedRules']>
  ): ReturnType<AdminService['resetPublishedRules']> {
    return this.legacyAdminService.resetPublishedRules(...args);
  }

  getChatPoll(
    ...args: Parameters<AdminService['getChatPoll']>
  ): ReturnType<AdminService['getChatPoll']> {
    return this.legacyAdminService.getChatPoll(...args);
  }

  updateChatPoll(
    ...args: Parameters<AdminService['updateChatPoll']>
  ): ReturnType<AdminService['updateChatPoll']> {
    return this.legacyAdminService.updateChatPoll(...args);
  }

  publishChatPoll(
    ...args: Parameters<AdminService['publishChatPoll']>
  ): ReturnType<AdminService['publishChatPoll']> {
    return this.legacyAdminService.publishChatPoll(...args);
  }

  closeChatPoll(
    ...args: Parameters<AdminService['closeChatPoll']>
  ): ReturnType<AdminService['closeChatPoll']> {
    return this.legacyAdminService.closeChatPoll(...args);
  }

  getChannelSettings(
    ...args: Parameters<AdminService['getChannelSettings']>
  ): ReturnType<AdminService['getChannelSettings']> {
    return this.legacyAdminService.getChannelSettings(...args);
  }

  getChannelSettingsScreen(
    ...args: Parameters<AdminService['getChannelSettingsScreen']>
  ): ReturnType<AdminService['getChannelSettingsScreen']> {
    return this.legacyAdminService.getChannelSettingsScreen(...args);
  }

  updateChannelSettings(
    ...args: Parameters<AdminService['updateChannelSettings']>
  ): ReturnType<AdminService['updateChannelSettings']> {
    return this.legacyAdminService.updateChannelSettings(...args);
  }

  publishChannelEngagementMessage(
    ...args: Parameters<AdminService['publishChannelEngagementMessage']>
  ): ReturnType<AdminService['publishChannelEngagementMessage']> {
    return this.legacyAdminService.publishChannelEngagementMessage(...args);
  }

  getChannelPoll(
    ...args: Parameters<AdminService['getChannelPoll']>
  ): ReturnType<AdminService['getChannelPoll']> {
    return this.legacyAdminService.getChannelPoll(...args);
  }

  updateChannelPoll(
    ...args: Parameters<AdminService['updateChannelPoll']>
  ): ReturnType<AdminService['updateChannelPoll']> {
    return this.legacyAdminService.updateChannelPoll(...args);
  }

  publishChannelPoll(
    ...args: Parameters<AdminService['publishChannelPoll']>
  ): ReturnType<AdminService['publishChannelPoll']> {
    return this.legacyAdminService.publishChannelPoll(...args);
  }

  closeChannelPoll(
    ...args: Parameters<AdminService['closeChannelPoll']>
  ): ReturnType<AdminService['closeChannelPoll']> {
    return this.legacyAdminService.closeChannelPoll(...args);
  }

  applySettingsToAllChats(
    ...args: Parameters<AdminService['applySettingsToAllChats']>
  ): ReturnType<AdminService['applySettingsToAllChats']> {
    return this.legacyAdminService.applySettingsToAllChats(...args);
  }

  applySettingsSectionToAllChats(
    ...args: Parameters<AdminService['applySettingsSectionToAllChats']>
  ): ReturnType<AdminService['applySettingsSectionToAllChats']> {
    return this.legacyAdminService.applySettingsSectionToAllChats(...args);
  }

  previewApplySettingsSectionTarget(
    ...args: Parameters<AdminService['previewApplySettingsSectionTarget']>
  ): ReturnType<AdminService['previewApplySettingsSectionTarget']> {
    return this.legacyAdminService.previewApplySettingsSectionTarget(...args);
  }
}
