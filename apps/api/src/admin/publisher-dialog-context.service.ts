import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import type { MaxMessageButton } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import {
  buildManagedBroadcastLinkButtonRows,
  normalizeManagedBroadcastButtons,
} from './admin-managed-broadcast-buttons';
import {
  readManagedBroadcastLedgerCommentDialogContext,
  type ManagedBroadcastCommentDialogReference,
} from './admin-managed-broadcast-ledger';

export type PublisherPreparedDialogContext = {
  version: 1;
  dialogBotId: string;
  buttons: MaxMessageButton[][];
  reference: ManagedBroadcastCommentDialogReference | null;
};

const MAX_PERSISTED_DIALOG_CONTEXT_BYTES = 64 * 1024;

export function readPublisherPreparedDialogContext(
  value: unknown,
  expectedDialogBotId: string,
): PublisherPreparedDialogContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_PERSISTED_DIALOG_CONTEXT_BYTES) {
      return null;
    }
  } catch {
    return null;
  }
  if (
    raw.version !== 1 ||
    raw.dialogBotId !== expectedDialogBotId ||
    !Array.isArray(raw.buttons) ||
    raw.buttons.some(
      (row) =>
        !Array.isArray(row) ||
        row.length === 0 ||
        row.some((button) => !button || typeof button !== 'object' || Array.isArray(button)),
    )
  ) {
    return null;
  }
  const parsedReference = readManagedBroadcastLedgerCommentDialogContext({
    ledgerContext: {
      managedBroadcast: { commentDialogReference: raw.reference ?? null },
    },
  });
  if (!parsedReference.found) {
    return null;
  }
  return {
    version: 1,
    dialogBotId: expectedDialogBotId,
    buttons: raw.buttons as MaxMessageButton[][],
    reference: parsedReference.reference,
  };
}

@Injectable()
export class PublisherDialogContextService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dialogLinks: PublisherDialogLinkService,
  ) {}

  async prepare(params: {
    chatId: string;
    entityType: ManagedEntityType;
    dialogBotId: string;
    customButtons: readonly BroadcastLinkButton[];
    includeManagedDialogs?: boolean;
  }): Promise<PublisherPreparedDialogContext> {
    const customButtons = normalizeManagedBroadcastButtons(params.customButtons);
    const buttons = buildManagedBroadcastLinkButtonRows(
      customButtons,
      params.entityType === 'channel' ? { buttonsPerRow: 1 } : undefined,
    );
    const threadId = randomUUID();
    let reference: ManagedBroadcastCommentDialogReference | null = null;

    if (params.includeManagedDialogs === false) {
      return { version: 1, dialogBotId: params.dialogBotId, buttons, reference };
    }

    if (params.entityType === 'chat') {
      const settings = await this.prisma.publisherEntitySettings.upsert({
        where: { chatId: params.chatId },
        create: { chatId: params.chatId },
        update: {},
        select: { chatCommentsEnabled: true, chatCommentsPostsEnabled: true },
      });
      if (settings.chatCommentsEnabled && settings.chatCommentsPostsEnabled) {
        buttons.push([
          this.dialogLinks.buildChatDialogButton(
            params.chatId,
            'comments',
            threadId,
            formatCommentsButtonText('💬 Комментарии', 0),
          ),
        ]);
        reference = {
          entityType: 'chat',
          threadId,
          includeCommentsButton: true,
          includeSuggestButton: false,
          suggestButtonText: null,
          customButtons,
          suggestionEntryMode: null,
          botId: null,
          dialogBotId: params.dialogBotId,
        };
      }
    } else {
      const settings = await this.prisma.publisherEntitySettings.upsert({
        where: { chatId: params.chatId },
        create: { chatId: params.chatId },
        update: {},
        select: { channelSuggestionsEnabled: true },
      });
      const suggestText = '📰 Предложить пост';
      if (settings.channelSuggestionsEnabled) {
        buttons.push([
          this.dialogLinks.buildChannelDialogButton(
            params.chatId,
            'suggest',
            threadId,
            suggestText,
            'MINIAPP',
          ),
        ]);
        reference = {
          entityType: 'channel',
          threadId,
          includeCommentsButton: false,
          includeSuggestButton: true,
          suggestButtonText: suggestText,
          customButtons,
          suggestionEntryMode: 'MINIAPP',
          botId: null,
          dialogBotId: params.dialogBotId,
        };
      }
    }

    return { version: 1, dialogBotId: params.dialogBotId, buttons, reference };
  }

  read(value: unknown, expectedDialogBotId: string): PublisherPreparedDialogContext | null {
    return readPublisherPreparedDialogContext(value, expectedDialogBotId);
  }
}
