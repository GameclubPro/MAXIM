import type { Logger } from '@nestjs/common';
import type {
  BroadcastLinkButton,
  ChannelSettings,
  ChatSummary,
  ManagedEntityType,
} from '@maxim/contracts';

import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxClientService, MaxMessageButton } from '../max/max-client.service';
import type { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import type { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import type { SystemModeSnapshot } from '../system/system-mode.service';
import type { AdminReadBypassOptions } from './admin.service.support';
import type { ChannelPostSignatureService } from './channel-post-signature.service';

export type ManagedBroadcastButtonContextOptions = {
  customButtons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
  includeCustomButton: boolean;
  customButtonText: string;
  customButtonUrl: string;
};

export type ManagedBroadcastButtonContextResult = {
  buttons: MaxMessageButton[][];
  commentDialogReference: {
    entityType: ManagedEntityType;
    threadId: string;
    includeCommentsButton: boolean;
    includeSuggestButton: boolean;
    suggestButtonText: string | null;
    customButtons: BroadcastLinkButton[];
    autoPostButtonsMode: ChannelSettings['autoPostButtonsMode'] | null;
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
    botId: string | null;
  } | null;
};

export type AdminManagedBroadcastRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService;
  readonly managedEntityAccessLossService?: ManagedEntityAccessLossService;
  readonly maxRoutedPublicationService?: MaxRoutedPublicationService;
  readonly channelPostSignatureService?: ChannelPostSignatureService;
  managedBroadcastDegradePauseLogAtMs: number;
  resolveSystemModeSnapshot(): Promise<SystemModeSnapshot>;
  resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined>;
  resolvePrivateDeliveryBotId(botId?: string | null): string | undefined;
  resolvePrivateDialogChatId(user: AuthUser, botId?: string | null): Promise<string | null>;
  listChatsForMassBroadcast(
    user: AuthUser,
    options?: { discoveryMode?: 'full' | 'cached-first' },
  ): Promise<ChatSummary[]>;
  assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void>;
  assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options?: AdminReadBypassOptions,
  ): Promise<void>;
  resolveBroadcastButtonContext(
    chatId: string,
    entityType: ManagedEntityType,
    options: ManagedBroadcastButtonContextOptions,
    botId?: string,
  ): Promise<ManagedBroadcastButtonContextResult>;
};

type AdminManagedBroadcastRuntimeContextTarget = {
  prisma: PrismaService;
  maxClient: MaxClientService;
  logger: Logger;
  backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService;
  managedEntityAccessLossService?: ManagedEntityAccessLossService;
  maxRoutedPublicationService?: MaxRoutedPublicationService;
  channelPostSignatureService?: ChannelPostSignatureService;
  managedBroadcastDegradePauseLogAtMs: number;
  resolveSystemModeSnapshot(): Promise<SystemModeSnapshot>;
  resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined>;
  resolvePrivateDeliveryBotId(botId?: string | null): string | undefined;
  resolvePrivateDialogChatId(user: AuthUser, botId?: string | null): Promise<string | null>;
  listChatsForMassBroadcast(
    user: AuthUser,
    options?: { discoveryMode?: 'full' | 'cached-first' },
  ): Promise<ChatSummary[]>;
  assertManagedEntityAdminAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
  ): Promise<void>;
  assertManagedEntityReadAccess(
    chatId: string,
    userId: string,
    entityType: ManagedEntityType,
    options?: AdminReadBypassOptions,
  ): Promise<void>;
  resolveBroadcastButtonContext(
    chatId: string,
    entityType: ManagedEntityType,
    options: ManagedBroadcastButtonContextOptions,
    botId?: string,
  ): Promise<ManagedBroadcastButtonContextResult>;
};

export function createAdminManagedBroadcastRuntimeContext(
  target: object,
): AdminManagedBroadcastRuntimeContext {
  const typedTarget = target as AdminManagedBroadcastRuntimeContextTarget;

  return {
    get prisma(): PrismaService {
      return typedTarget.prisma;
    },
    get maxClient(): MaxClientService {
      return typedTarget.maxClient;
    },
    get logger(): Logger {
      return typedTarget.logger;
    },
    get backgroundRuntimeGovernorService(): BackgroundRuntimeGovernorService | undefined {
      return typedTarget.backgroundRuntimeGovernorService;
    },
    get managedEntityAccessLossService(): ManagedEntityAccessLossService | undefined {
      return typedTarget.managedEntityAccessLossService;
    },
    get maxRoutedPublicationService(): MaxRoutedPublicationService | undefined {
      return typedTarget.maxRoutedPublicationService;
    },
    get channelPostSignatureService(): ChannelPostSignatureService | undefined {
      return typedTarget.channelPostSignatureService;
    },
    get managedBroadcastDegradePauseLogAtMs(): number {
      return typedTarget.managedBroadcastDegradePauseLogAtMs;
    },
    set managedBroadcastDegradePauseLogAtMs(value: number) {
      typedTarget.managedBroadcastDegradePauseLogAtMs = value;
    },
    resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
      return typedTarget.resolveSystemModeSnapshot();
    },
    resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined> {
      return typedTarget.resolveDeliveryBotAssignment(chatId);
    },
    resolvePrivateDeliveryBotId(botId?: string | null): string | undefined {
      return typedTarget.resolvePrivateDeliveryBotId(botId);
    },
    resolvePrivateDialogChatId(user: AuthUser, botId?: string | null): Promise<string | null> {
      return typedTarget.resolvePrivateDialogChatId(user, botId);
    },
    listChatsForMassBroadcast(
      user: AuthUser,
      options?: { discoveryMode?: 'full' | 'cached-first' },
    ): Promise<ChatSummary[]> {
      return typedTarget.listChatsForMassBroadcast(user, options);
    },
    assertManagedEntityAdminAccess(
      chatId: string,
      userId: string,
      entityType: ManagedEntityType,
    ): Promise<void> {
      return typedTarget.assertManagedEntityAdminAccess(chatId, userId, entityType);
    },
    assertManagedEntityReadAccess(
      chatId: string,
      userId: string,
      entityType: ManagedEntityType,
      options?: AdminReadBypassOptions,
    ): Promise<void> {
      return typedTarget.assertManagedEntityReadAccess(chatId, userId, entityType, options);
    },
    resolveBroadcastButtonContext(
      chatId: string,
      entityType: ManagedEntityType,
      options: ManagedBroadcastButtonContextOptions,
      botId?: string,
    ): Promise<ManagedBroadcastButtonContextResult> {
      return typedTarget.resolveBroadcastButtonContext(chatId, entityType, options, botId);
    },
  };
}
