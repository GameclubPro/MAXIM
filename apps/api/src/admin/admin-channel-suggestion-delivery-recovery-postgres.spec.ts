import { randomUUID } from 'node:crypto';

import {
  ChannelSuggestionAdminDeliveryStatus,
  createPrismaClient,
  type PrismaClient,
} from '../prisma/prisma-client';
import { recoverChannelSuggestionAdminDeliveriesAfterBotStarted } from './admin-channel-suggestion-delivery-recovery';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

jest.setTimeout(30_000);

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

describePostgres('PostgreSQL channel suggestion delivery recovery', () => {
  let prisma: PrismaClient;
  const createdChatIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2, statement_timeout: 10_000 });
    await prisma.$connect();
  });

  afterEach(async () => {
    if (createdChatIds.length > 0) {
      await prisma.chat.deleteMany({ where: { id: { in: createdChatIds.splice(0) } } });
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('executes the recovery update and reopens an eligible terminal delivery', async () => {
    const suffix = randomUUID();
    const chatId = `suggestion-delivery-recovery-chat-${suffix}`;
    const auditLogId = `suggestion-delivery-recovery-audit-${suffix}`;
    const deliveryId = `suggestion-delivery-recovery-row-${suffix}`;
    createdChatIds.push(chatId);

    await prisma.chat.create({
      data: { id: chatId, title: 'Suggestion delivery recovery' },
    });
    await prisma.auditLog.create({
      data: {
        id: auditLogId,
        chatId,
        actorUserId: 'suggestion-delivery-recovery-author',
        action: 'CHANNEL_DIALOG_SUGGESTION',
        payload: {
          reviewStatus: 'pending',
          deliveryAttemptedAt: '2026-08-31T10:00:00.000Z',
        },
      },
    });
    const delivery = await prisma.channelSuggestionAdminDelivery.create({
      data: {
        id: deliveryId,
        auditLogId,
        adminUserId: 'suggestion-delivery-recovery-admin',
        botKey: 'suggestion-delivery-recovery-bot',
        botId: 'suggestion-delivery-recovery-bot-id',
        privateChatId: 'suggestion-delivery-recovery-dialog',
        status: ChannelSuggestionAdminDeliveryStatus.FAILED,
        remoteMessageId: 'suggestion-delivery-recovery-message',
        lastError: 'dialog unavailable',
        lastStatusCode: 404,
        lastErrorCode: 'dialog.not.found',
        terminal: true,
        sentAt: new Date('2026-08-31T10:00:00.000Z'),
        lockedAt: new Date('2026-08-31T10:00:00.000Z'),
        lockToken: 'suggestion-delivery-recovery-lock',
      },
      select: {
        id: true,
        adminUserId: true,
        status: true,
        terminal: true,
        botId: true,
        lastStatusCode: true,
        lastErrorCode: true,
      },
    });

    await expect(
      recoverChannelSuggestionAdminDeliveriesAfterBotStarted({
        prisma: prisma as never,
        auditLogId,
        rows: [delivery],
      }),
    ).resolves.toBe(1);

    await expect(
      prisma.channelSuggestionAdminDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({
      status: ChannelSuggestionAdminDeliveryStatus.PENDING,
      privateChatId: null,
      remoteMessageId: null,
      sentAt: null,
      lockedAt: null,
      lockToken: null,
      lastError: null,
      lastStatusCode: null,
      lastErrorCode: null,
      terminal: false,
    });
  });
});
