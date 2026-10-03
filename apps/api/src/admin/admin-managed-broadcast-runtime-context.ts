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
import type { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import type { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
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
    suggestionEntryMode: ChannelSettings['postSuggestionsEntryMode'] | null;
    botId: string | null;
    dialogBotId?: string | null;
    buttonRows?: MaxMessageButton[][];
    commentsButton?: { rowIndex: number; columnIndex: number; baseText: string | null } | null;
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
  readonly publisherRuntimeBoundaryService?: PublisherRuntimeBoundaryService;
  readonly publisherReadinessService?: PublisherReadinessService;
  readonly publisherDispatchHealthService?: PublisherDispatchHealthService;
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
  dependencies: AdminManagedBroadcastRuntimeContext,
): AdminManagedBroadcastRuntimeContext {
  return dependencies;
}
