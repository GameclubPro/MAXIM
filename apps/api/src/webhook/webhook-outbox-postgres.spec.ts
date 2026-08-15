import { randomUUID } from 'node:crypto';

import {
  createPrismaClient,
  type PrismaClient,
  WebhookStatus,
} from '../prisma/prisma-client';
import { WebhookOutboxService } from './webhook-outbox.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

type OrderedWebhookHead = {
  id: string;
  createdAt: Date;
};

type OrderedWebhookHeadReader = {
  findOrderedWebhookHeadsForChats: (
    chatIds: readonly string[],
  ) => Promise<Map<string, OrderedWebhookHead>>;
};

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

describePostgres('PostgreSQL webhook outbox queries', () => {
  let prisma: PrismaClient;
  let reader: OrderedWebhookHeadReader;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    const service = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(service, 'prisma', { value: prisma });
    reader = service as OrderedWebhookHeadReader;
  });

  afterEach(async () => {
    if (createdEventIds.length === 0) {
      return;
    }
    await prisma.webhookEvent.deleteMany({
      where: { id: { in: createdEventIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('executes the bulk ordered-head query and returns the oldest event per chat', async () => {
    const suffix = randomUUID();
    const chatA = `outbox-chat-a-${suffix}`;
    const chatB = `outbox-chat-b-${suffix}`;
    const emptyChat = `outbox-chat-empty-${suffix}`;
    const firstCreatedAt = new Date('2026-08-15T08:00:00.000Z');
    const secondCreatedAt = new Date('2026-08-15T08:00:01.000Z');
    const eventAFirst = `outbox-a-1-${suffix}`;
    const eventASecond = `outbox-a-2-${suffix}`;
    const eventB = `outbox-b-1-${suffix}`;
    createdEventIds.push(eventAFirst, eventASecond, eventB);

    await prisma.webhookEvent.createMany({
      data: [
        {
          id: eventASecond,
          dedupKey: `outbox-dedup-a-2-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatA },
          },
          createdAt: secondCreatedAt,
        },
        {
          id: eventAFirst,
          dedupKey: `outbox-dedup-a-1-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_edited',
            message: { chatId: chatA },
          },
          createdAt: firstCreatedAt,
        },
        {
          id: eventB,
          dedupKey: `outbox-dedup-b-1-${suffix}`,
          status: WebhookStatus.FAILED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatB },
          },
          nextEnqueueAt: secondCreatedAt,
          createdAt: secondCreatedAt,
        },
      ],
    });

    const heads = await reader.findOrderedWebhookHeadsForChats([chatA, chatB, emptyChat]);

    expect(heads).toEqual(
      new Map([
        [chatA, { id: eventAFirst, createdAt: firstCreatedAt }],
        [chatB, { id: eventB, createdAt: secondCreatedAt }],
      ]),
    );
  });
});
