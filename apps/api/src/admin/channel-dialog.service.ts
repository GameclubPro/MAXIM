import { Injectable } from '@nestjs/common';
import { AdminService } from './admin.service';

@Injectable()
export class ChannelDialogService {
  constructor(private readonly legacyAdminService: AdminService) {}

  getChannelSuggestionRedirect(
    ...args: Parameters<AdminService['getChannelSuggestionRedirect']>
  ): ReturnType<AdminService['getChannelSuggestionRedirect']> {
    return this.legacyAdminService.getChannelSuggestionRedirect(...args);
  }

  getChannelDialog(
    ...args: Parameters<AdminService['getChannelDialog']>
  ): ReturnType<AdminService['getChannelDialog']> {
    return this.legacyAdminService.getChannelDialog(...args);
  }

  createChannelDialogMessage(
    ...args: Parameters<AdminService['createChannelDialogMessage']>
  ): ReturnType<AdminService['createChannelDialogMessage']> {
    return this.legacyAdminService.createChannelDialogMessage(...args);
  }

  updateChannelDialogNotifications(
    ...args: Parameters<AdminService['updateChannelDialogNotifications']>
  ): ReturnType<AdminService['updateChannelDialogNotifications']> {
    return this.legacyAdminService.updateChannelDialogNotifications(...args);
  }

  updateChannelDialogMessage(
    ...args: Parameters<AdminService['updateChannelDialogMessage']>
  ): ReturnType<AdminService['updateChannelDialogMessage']> {
    return this.legacyAdminService.updateChannelDialogMessage(...args);
  }

  deleteChannelDialogMessage(
    ...args: Parameters<AdminService['deleteChannelDialogMessage']>
  ): ReturnType<AdminService['deleteChannelDialogMessage']> {
    return this.legacyAdminService.deleteChannelDialogMessage(...args);
  }

  toggleChannelDialogReaction(
    ...args: Parameters<AdminService['toggleChannelDialogReaction']>
  ): ReturnType<AdminService['toggleChannelDialogReaction']> {
    return this.legacyAdminService.toggleChannelDialogReaction(...args);
  }

  getChatDialog(
    ...args: Parameters<AdminService['getChatDialog']>
  ): ReturnType<AdminService['getChatDialog']> {
    return this.legacyAdminService.getChatDialog(...args);
  }

  createChatDialogMessage(
    ...args: Parameters<AdminService['createChatDialogMessage']>
  ): ReturnType<AdminService['createChatDialogMessage']> {
    return this.legacyAdminService.createChatDialogMessage(...args);
  }

  updateChatDialogNotifications(
    ...args: Parameters<AdminService['updateChatDialogNotifications']>
  ): ReturnType<AdminService['updateChatDialogNotifications']> {
    return this.legacyAdminService.updateChatDialogNotifications(...args);
  }

  updateChatDialogMessage(
    ...args: Parameters<AdminService['updateChatDialogMessage']>
  ): ReturnType<AdminService['updateChatDialogMessage']> {
    return this.legacyAdminService.updateChatDialogMessage(...args);
  }

  deleteChatDialogMessage(
    ...args: Parameters<AdminService['deleteChatDialogMessage']>
  ): ReturnType<AdminService['deleteChatDialogMessage']> {
    return this.legacyAdminService.deleteChatDialogMessage(...args);
  }

  toggleChatDialogReaction(
    ...args: Parameters<AdminService['toggleChatDialogReaction']>
  ): ReturnType<AdminService['toggleChatDialogReaction']> {
    return this.legacyAdminService.toggleChatDialogReaction(...args);
  }

  processChannelSuggestionDeliveryJob(
    ...args: Parameters<AdminService['processChannelSuggestionDeliveryJob']>
  ): ReturnType<AdminService['processChannelSuggestionDeliveryJob']> {
    return this.legacyAdminService.processChannelSuggestionDeliveryJob(...args);
  }
}
