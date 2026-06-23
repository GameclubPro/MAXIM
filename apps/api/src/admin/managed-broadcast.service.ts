import {
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
} from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { AdminManagedBroadcastRuntime, type AdminActionSource } from './admin-managed-broadcast-runtime';

type AdminReadBypassOptions = {
  skipAdminCheck?: boolean;
  skipEntityCheck?: boolean;
};

@Injectable()
export class ManagedBroadcastService {
  constructor(private readonly runtime: AdminManagedBroadcastRuntime) {}

  sendBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.runtime.sendBroadcast(sourceChatId, user, body, source);
  }

  sendChannelBroadcast(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    return this.runtime.sendChannelBroadcast(sourceChatId, user, body, source);
  }

  sendBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.runtime.sendBroadcastTest(sourceChatId, user, body);
  }

  sendChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.runtime.sendChannelBroadcastTest(sourceChatId, user, body);
  }

  listManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.runtime.listManagedBroadcasts(sourceChatId, user, options);
  }

  listChannelManagedBroadcasts(
    sourceChatId: string,
    user: AuthUser,
    options: AdminReadBypassOptions = {},
  ): Promise<ManagedBroadcastSummary[]> {
    return this.runtime.listChannelManagedBroadcasts(sourceChatId, user, options);
  }

  getManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.runtime.getManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getChannelManagedBroadcastCalendar(
    sourceChatId: string,
    user: AuthUser,
    query: unknown,
  ): Promise<ManagedBroadcastCalendarResponse> {
    return this.runtime.getChannelManagedBroadcastCalendar(sourceChatId, user, query);
  }

  getManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.getManagedBroadcast(sourceChatId, broadcastId, user);
  }

  getChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.getChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  updateManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.updateManagedBroadcast(sourceChatId, broadcastId, user, body);
  }

  updateChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.updateChannelManagedBroadcast(sourceChatId, broadcastId, user, body);
  }

  cancelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.cancelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  cancelChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.cancelChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  retryManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.retryManagedBroadcast(sourceChatId, broadcastId, user);
  }

  retryChannelManagedBroadcast(
    sourceChatId: string,
    broadcastId: string,
    user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    return this.runtime.retryChannelManagedBroadcast(sourceChatId, broadcastId, user);
  }

  processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    return this.runtime.processDueManagedBroadcasts(reason);
  }
}
