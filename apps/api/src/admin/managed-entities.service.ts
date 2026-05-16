import { Injectable } from '@nestjs/common';
import { AdminService } from './admin.service';

@Injectable()
export class ManagedEntitiesService {
  constructor(private readonly legacyAdminService: AdminService) {}

  getMe(...args: Parameters<AdminService['getMe']>): ReturnType<AdminService['getMe']> {
    return this.legacyAdminService.getMe(...args);
  }

  listChats(...args: Parameters<AdminService['listChats']>): ReturnType<AdminService['listChats']> {
    return this.legacyAdminService.listChats(...args);
  }

  listChatsWithRefreshState(
    ...args: Parameters<AdminService['listChatsWithRefreshState']>
  ): ReturnType<AdminService['listChatsWithRefreshState']> {
    return this.legacyAdminService.listChatsWithRefreshState(...args);
  }

  listChannels(
    ...args: Parameters<AdminService['listChannels']>
  ): ReturnType<AdminService['listChannels']> {
    return this.legacyAdminService.listChannels(...args);
  }

  listChannelsWithRefreshState(
    ...args: Parameters<AdminService['listChannelsWithRefreshState']>
  ): ReturnType<AdminService['listChannelsWithRefreshState']> {
    return this.legacyAdminService.listChannelsWithRefreshState(...args);
  }

  getChatHeader(
    ...args: Parameters<AdminService['getChatHeader']>
  ): ReturnType<AdminService['getChatHeader']> {
    return this.legacyAdminService.getChatHeader(...args);
  }

  getChannelHeader(
    ...args: Parameters<AdminService['getChannelHeader']>
  ): ReturnType<AdminService['getChannelHeader']> {
    return this.legacyAdminService.getChannelHeader(...args);
  }

  getChatBotExecutionPlan(
    ...args: Parameters<AdminService['getChatBotExecutionPlan']>
  ): ReturnType<AdminService['getChatBotExecutionPlan']> {
    return this.legacyAdminService.getChatBotExecutionPlan(...args);
  }

  getChannelBotExecutionPlan(
    ...args: Parameters<AdminService['getChannelBotExecutionPlan']>
  ): ReturnType<AdminService['getChannelBotExecutionPlan']> {
    return this.legacyAdminService.getChannelBotExecutionPlan(...args);
  }

  updateChatPrimaryBot(
    ...args: Parameters<AdminService['updateChatPrimaryBot']>
  ): ReturnType<AdminService['updateChatPrimaryBot']> {
    return this.legacyAdminService.updateChatPrimaryBot(...args);
  }

  updateChannelPrimaryBot(
    ...args: Parameters<AdminService['updateChannelPrimaryBot']>
  ): ReturnType<AdminService['updateChannelPrimaryBot']> {
    return this.legacyAdminService.updateChannelPrimaryBot(...args);
  }

  updateChatPartnerAssist(
    ...args: Parameters<AdminService['updateChatPartnerAssist']>
  ): ReturnType<AdminService['updateChatPartnerAssist']> {
    return this.legacyAdminService.updateChatPartnerAssist(...args);
  }

  updateChannelPartnerAssist(
    ...args: Parameters<AdminService['updateChannelPartnerAssist']>
  ): ReturnType<AdminService['updateChannelPartnerAssist']> {
    return this.legacyAdminService.updateChannelPartnerAssist(...args);
  }

  promoteChatStandbyBot(
    ...args: Parameters<AdminService['promoteChatStandbyBot']>
  ): ReturnType<AdminService['promoteChatStandbyBot']> {
    return this.legacyAdminService.promoteChatStandbyBot(...args);
  }

  promoteChannelStandbyBot(
    ...args: Parameters<AdminService['promoteChannelStandbyBot']>
  ): ReturnType<AdminService['promoteChannelStandbyBot']> {
    return this.legacyAdminService.promoteChannelStandbyBot(...args);
  }

  updateManagedEntityFavorites(
    ...args: Parameters<AdminService['updateManagedEntityFavorites']>
  ): ReturnType<AdminService['updateManagedEntityFavorites']> {
    return this.legacyAdminService.updateManagedEntityFavorites(...args);
  }

  processManagedEntitiesRefreshJob(
    ...args: Parameters<AdminService['processManagedEntitiesRefreshJob']>
  ): ReturnType<AdminService['processManagedEntitiesRefreshJob']> {
    return this.legacyAdminService.processManagedEntitiesRefreshJob(...args);
  }
}
