import {
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
} from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AdminService, type AdminActionSource } from './admin.service';

type AdminReadBypassOptions = {
  skipAdminCheck?: boolean;
  skipEntityCheck?: boolean;
};

@Injectable()
export class ManagedBroadcastService {
  constructor(private readonly legacyAdminService: AdminService) {}

  sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.legacyAdminService.sendBroadcast(sourceChatId, user, body, source);
  }

  sendChannelBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.legacyAdminService.sendChannelBroadcast(sourceChatId, user, body, source);
  }

  sendBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.legacyAdminService.sendBroadcastTest(sourceChatId, user, body);
  }

  sendChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.legacyAdminService.sendChannelBroadcastTest(sourceChatId, user, body);
  }

  listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.legacyAdminService.listManagedBroadcasts(sourceChatId, user, options);
  }

  listChannelManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.legacyAdminService.listChannelManagedBroadcasts(sourceChatId, user, options);
  }

  getManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.legacyAdminService.getManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getChannelManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.legacyAdminService.getChannelManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.getManagedBroadcast(sourceChatId, broadcastId, user);
  }

  getChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.getChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  updateManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.updateManagedBroadcast(sourceChatId, broadcastId, user, body);
  }

  updateChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.updateChannelManagedBroadcast(
      sourceChatId,
      broadcastId,
      user,
      body,
    );
  }

  cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.cancelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  cancelChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.cancelChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  retryManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.retryManagedBroadcast(sourceChatId, broadcastId, user);
  }

  retryChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.legacyAdminService.retryChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    return this.legacyAdminService.processDueManagedBroadcasts(reason);
  }
}
