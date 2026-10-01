import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)('logical message immunity PostgreSQL races', () => {
  let prisma: PrismaClient;
  let service: ParticipantModerationImmunityService;
  const chatId = `commercial-immunity-${randomUUID()}`;
  const input = {
    chatId,
    userId: 'test-user',
    messageId: 'race-message',
    scope: 'text',
    nightModeTimezone: 'Europe/Moscow',
  };
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Immunity races require a disposable local race_test database');
    prisma = createPrismaClient(databaseUrl, { max: 8 });
    await prisma.$connect();
    await prisma.chat.create({ data: { id: chatId, title: 'Commercial immunity race test' } });
    service = new ParticipantModerationImmunityService(prisma as never);
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await prisma.moderationViolationMessageClaim.deleteMany({ where: { chatId } });
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    await prisma.chatParticipantModerationImmunity.create({
      data: {
        chatId,
        userId: input.userId,
        dailyViolationLimit: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });
  it('uses one quota unit for parallel rules, OCR, mirrors and subsequent edits', async () => {
    const results = await Promise.all(
      ['text', 'OCR', 'mirror', 'other-rule'].map((scope) =>
        service.consumeForMessage({ ...input, scope }),
      ),
    );
    expect(results).toEqual(['granted', 'granted', 'granted', 'granted']);
    await expect(service.consumeForMessage({ ...input, scope: 'edit' })).resolves.toBe('granted');
    const grant = await prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
      where: { chatId_userId: { chatId, userId: input.userId } },
    });
    expect(grant.dailyViolationUsage).toBe(1);
    expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
  });
  it('does not overspend the daily limit when distinct messages race', async () => {
    const results = await Promise.all(
      ['first', 'second', 'third'].map((messageId) =>
        service.consumeForMessage({ ...input, messageId }),
      ),
    );
    expect(results.filter((result) => result === 'granted')).toHaveLength(1);
    expect(await prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(1);
  });
  it('does not treat an old receipt as authority after expiry or revocation', async () => {
    await expect(service.consumeForMessage(input)).resolves.toBe('granted');
    await prisma.chatParticipantModerationImmunity.updateMany({
      where: { chatId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
    await prisma.chatParticipantModerationImmunity.deleteMany({ where: { chatId } });
    await expect(service.consumeForMessage(input)).resolves.toBe('not_granted');
  });
});
