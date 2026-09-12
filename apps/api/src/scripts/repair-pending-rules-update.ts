import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { publishChatRules } from '../admin/admin-chat-rules';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  prepareMarkdownForMaxDelivery,
} from '../common/max-markdown.util';
import { MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';

export function readPendingRulesUpdateOptions(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      'chat-id': { type: 'string' },
      'message-id': { type: 'string' },
      'pending-message-id': { type: 'string' },
      'bot-id': { type: 'string' },
      'expected-updated-at': { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  });
  const chatId = values['chat-id'] ?? '';
  const messageId = values['message-id'] ?? '';
  const pendingMessageId = values['pending-message-id'] ?? '';
  const botId = values['bot-id'] ?? '';
  const expectedUpdatedAt = values['expected-updated-at'];
  if (
    !/^-[1-9][0-9]{0,19}$/u.test(chatId) ||
    chatId.trim() !== chatId ||
    messageId.trim() !== messageId ||
    pendingMessageId.trim() !== pendingMessageId ||
    botId.trim() !== botId ||
    !/^mid\.[A-Za-z0-9._-]{1,200}$/u.test(messageId) ||
    !/^mid\.[A-Za-z0-9._-]{1,200}$/u.test(pendingMessageId) ||
    messageId === pendingMessageId ||
    !/^[A-Za-z0-9_]{1,100}$/u.test(botId) ||
    (expectedUpdatedAt !== undefined &&
      (!Number.isFinite(Date.parse(expectedUpdatedAt)) ||
        new Date(expectedUpdatedAt).toISOString() !== expectedUpdatedAt)) ||
    (values.apply && !expectedUpdatedAt)
  ) {
    throw new Error(
      'Require exact --chat-id, --message-id, --pending-message-id and --bot-id; --apply also requires the preview --expected-updated-at ISO timestamp',
    );
  }
  return { chatId, messageId, pendingMessageId, botId, expectedUpdatedAt, apply: values.apply };
}

export async function repairPendingRulesUpdate(
  dependencies: {
    prisma: PrismaService;
    maxClient: MaxClientService;
    chatContextCache: ChatContextCacheService;
  },
  options: ReturnType<typeof readPendingRulesUpdateOptions>,
) {
  const { prisma, maxClient, chatContextCache } = dependencies;
  const rules = await prisma.chatRules.findUnique({ where: { chatId: options.chatId } });
  if (
    !rules ||
    rules.publishedMessageId !== options.messageId ||
    rules.publishedBotId !== options.botId ||
    rules.pendingCleanupMessageId !== options.pendingMessageId ||
    rules.pendingCleanupKind !== 'republish_previous' ||
    rules.publishOperationId ||
    rules.publishSendStartedAt ||
    rules.adminContactButtonEnabled ||
    !rules.text.trim() ||
    (options.expectedUpdatedAt && rules.updatedAt.toISOString() !== options.expectedUpdatedAt)
  ) {
    throw new Error(
      'Rules no longer match the reviewed repair, have an active send fence, or require interactive contact/autofill formatting',
    );
  }
  const summary = {
    chatId: rules.chatId,
    messageId: rules.publishedMessageId,
    botId: rules.publishedBotId,
    pendingMessageId: rules.pendingCleanupMessageId,
    updatedAt: rules.updatedAt.toISOString(),
    textLength: rules.text.length,
    hasImage: Boolean(rules.imageBase64),
    applied: false,
  };
  if (!options.apply) return summary;

  // FLAG: The repair may only edit the reviewed current post. Never create or delete a message.
  const forbidden = async (): Promise<never> => {
    throw new Error('Rules update repair cannot send or delete messages');
  };
  const result = await publishChatRules({
    prisma,
    chatContextCache,
    logger: new Logger('PendingRulesUpdateRepair'),
    chatId: options.chatId,
    actorUserId: 'operator:rules-publication-update',
    source: 'private_command',
    expectedUpdatedAt: rules.updatedAt,
    maxClient: {
      deleteMessage: forbidden,
      sendMessageImmediateWithResolvedLink: forbidden,
      uploadImage: maxClient.uploadImage.bind(maxClient),
      resolveMessageLink: maxClient.resolveMessageLink.bind(maxClient),
      replaceOwnMessage: async (chatId, messageId, text, messageOptions, requestOptions, guard) => {
        if (
          chatId !== options.chatId ||
          messageId !== options.messageId ||
          requestOptions.botId !== options.botId
        ) {
          throw new Error('Rules update repair target changed');
        }
        await maxClient.replaceOwnMessage(
          chatId,
          messageId,
          text,
          messageOptions,
          requestOptions,
          guard,
        );
      },
    },
    resolveBotId: forbidden,
    buildAutofilledText: forbidden,
    buildFormattedText: async (text, format) => {
      if (format.adminContactButtonEnabled)
        throw new Error('Contact formatting requires interactive publication');
      if (format.textFormat === 'plain') {
        if (text.length > MAX_MESSAGE_TEXT_LENGTH)
          throw new Error('Rules exceed the MAX message limit');
        return { text };
      }
      const prepared = prepareMarkdownForMaxDelivery(text);
      if (!prepared) throw new Error('Formatted rules exceed the MAX message limit');
      return prepared;
    },
    sendPrivateConfirmation: forbidden,
    deletePreviousPublishedMessage: forbidden,
  });
  return { ...summary, messageId: result.messageId, applied: true };
}

async function main() {
  const options = readPendingRulesUpdateOptions(process.argv.slice(2));
  if (process.env.APP_SERVICE_NAME !== 'api-admin')
    throw new Error('Run this repair only inside api-admin');
  if (options.apply) {
    const response = await fetch(
      `http://127.0.0.1:${process.env.PORT || '3000'}/api/health/ready`,
      { signal: AbortSignal.timeout(5_000) },
    );
    const health = (await response.json()) as {
      ok?: boolean;
      systemMode?: { mode?: string };
      checks?: { queueLag?: { rawOk?: boolean } };
    };
    if (
      !response.ok ||
      !health.ok ||
      health.systemMode?.mode !== 'normal' ||
      !health.checks?.queueLag?.rawOk
    ) {
      throw new Error('Production is not ready for a rules update repair');
    }
  }
  const { RulesUpdateRepairModule } = await import('./rules-update-repair.module');
  const app = await NestFactory.createApplicationContext(RulesUpdateRepairModule, {
    logger: false,
  });
  try {
    console.log(
      JSON.stringify(
        await repairPendingRulesUpdate(
          {
            prisma: app.get(PrismaService),
            maxClient: app.get(MaxClientService),
            chatContextCache: app.get(ChatContextCacheService),
          },
          options,
        ),
      ),
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Rules update repair failed');
    process.exitCode = 1;
  });
}
