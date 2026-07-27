import {
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
} from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  AdminManagedBroadcastRuntime,
  type AdminActionSource,
} from './admin-managed-broadcast-runtime';
import type { ManagedBroadcastPublicationVerificationBudget } from './admin-managed-broadcast-publication-verification';
import { throwLegacyPublicationWritesDisabled } from './legacy-publication-write-freeze';

type AdminReadBypassOptions = {
  skipAdminCheck?: boolean;
  skipEntityCheck?: boolean;
};

type ManagedBroadcastRuntimePort = Pick<
  AdminManagedBroadcastRuntime,
  | 'sendPublicationBroadcastTest'
  | 'sendPublicationChannelBroadcastTest'
  | 'listManagedBroadcasts'
  | 'listChannelManagedBroadcasts'
  | 'getManagedBroadcastCalendar'
  | 'getChannelManagedBroadcastCalendar'
  | 'getManagedBroadcast'
  | 'getChannelManagedBroadcast'
  | 'cancelManagedBroadcast'
  | 'cancelChannelManagedBroadcast'
  | 'processDueManagedBroadcasts'
  | 'processDueImmediatePublicationBroadcasts'
  | 'processDueDeadlinePublicationBroadcasts'
>;

@Injectable()
export class ManagedBroadcastService {
  constructor(private readonly runtime: ManagedBroadcastRuntimePort) {}

  async sendBroadcast(
    _sourceChatId: string,
    _user: AuthUser,
    _body: unknown,
    _source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendChannelBroadcast(
    _sourceChatId: string,
    _user: AuthUser,
    _body: unknown,
    _source: AdminActionSource = 'miniapp',
  ): Promise<SendBroadcastResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendBroadcastTest(
    _sourceChatId: string,
    _user: AuthUser,
    _body: unknown,
  ): Promise<SendBroadcastTestResult> {
    throwLegacyPublicationWritesDisabled();
  }

  async sendChannelBroadcastTest(
    _sourceChatId: string,
    _user: AuthUser,
    _body: unknown,
  ): Promise<SendBroadcastTestResult> {
    throwLegacyPublicationWritesDisabled();
  }

  sendPublicationBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.runtime.sendPublicationBroadcastTest(sourceChatId, user, body);
  }

  sendPublicationChannelBroadcastTest(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<SendBroadcastTestResult> {
    return this.runtime.sendPublicationChannelBroadcastTest(sourceChatId, user, body);
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

  async updateManagedBroadcast(
    _sourceChatId: string,
    _broadcastId: string,
    _user: AuthUser,
    _body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  async updateChannelManagedBroadcast(
    _sourceChatId: string,
    _broadcastId: string,
    _user: AuthUser,
    _body: unknown,
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
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

  async retryManagedBroadcast(
    _sourceChatId: string,
    _broadcastId: string,
    _user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  async retryChannelManagedBroadcast(
    _sourceChatId: string,
    _broadcastId: string,
    _user: AuthUser,
  ): Promise<ManagedBroadcastDetails> {
    throwLegacyPublicationWritesDisabled();
  }

  processDueManagedBroadcasts(reason: 'startup' | 'scheduled'): Promise<void> {
    return this.runtime.processDueManagedBroadcasts(reason);
  }

  processDueImmediatePublicationBroadcasts(
    verificationBudget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<ManagedBroadcastPublicationVerificationBudget> {
    return verificationBudget
      ? this.runtime.processDueImmediatePublicationBroadcasts(verificationBudget)
      : this.runtime.processDueImmediatePublicationBroadcasts();
  }

  processDueDeadlinePublicationBroadcasts(
    limit?: number,
    verificationBudget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<ManagedBroadcastPublicationVerificationBudget> {
    return verificationBudget
      ? this.runtime.processDueDeadlinePublicationBroadcasts(limit, verificationBudget)
      : this.runtime.processDueDeadlinePublicationBroadcasts(limit);
  }
}
