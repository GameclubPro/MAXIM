import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('duplicate policy PostgreSQL revisions', () => {
  let prisma: PrismaClient;
  let chatId: string;
  const chatIds: string[] = [];

  const baseline = {
    antiDuplicateEnabled: true,
    duplicateDetectionPreset: 'CUSTOM' as const,
    duplicateCompareMode: 'MESSAGE',
    duplicatePhotoScope: 'SAME_AUTHOR' as const,
    duplicateWindowMode: 'INTERVAL',
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: false,
    duplicateBanEnabled: false,
    duplicateBotMessageEnabled: false,
    duplicateWarnWindowSec: 3600,
    duplicateMuteWindowSec: 7200,
    duplicateBanWindowSec: 10800,
    duplicateWarnMaxCount: 2,
    duplicateMuteMaxCount: 5,
    duplicateBanMaxCount: 9,
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    duplicateStartTimeMinutes: 540,
    duplicateEndTimeMinutes: 1080,
    duplicateTimezone: 'Europe/Moscow',
  };

  const read = () => prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
  const update = (data: Prisma.ChatSettingsUpdateInput) =>
    prisma.chatSettings.update({ where: { chatId }, data });
  const expectRevisions = async (history: number, policy: number) => {
    await expect(read()).resolves.toMatchObject({
      duplicateHistoryRevision: history,
      duplicatePolicyRevision: policy,
    });
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Duplicate policy tests require a disposable local race_test database');
    }
    prisma = createPrismaClient(databaseUrl, { max: 3 });
    await prisma.$connect();
  });

  beforeEach(async () => {
    chatId = `duplicate-policy-${randomUUID()}`;
    chatIds.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Policy regression' } });
    await prisma.chatSettings.create({ data: { chatId, ...baseline } });
  });

  afterEach(async () => {
    await prisma.chat.deleteMany({ where: { id: { in: chatIds.splice(0) } } });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('owns revisions on insert and rejects client rewinds or arbitrary increments on update', async () => {
    await prisma.chatSettings.delete({ where: { chatId } });
    await prisma.chatSettings.create({
      data: {
        chatId,
        ...baseline,
        duplicatePolicyRevision: -99,
        duplicateHistoryRevision: 99,
      },
    });
    await expectRevisions(0, 0);
    await update({ duplicatePolicyRevision: 100, duplicateHistoryRevision: -100 });
    await expectRevisions(0, 0);
    await update({ duplicateNearMatchEnabled: true });
    await update({ duplicatePolicyRevision: 0, duplicateHistoryRevision: 0 });
    await expectRevisions(1, 1);
  });

  it('keeps no-op, unrelated UI and retired photo compatibility writes out of policy revisions', async () => {
    await update({
      ...baseline,
      greetingEnabled: true,
      duplicatePhotoEnabled: true,
      duplicatePhotoMatchPreset: 'MINOR_EDITS',
    });
    await expectRevisions(0, 0);
    await update({ duplicatePhotoEnabled: false, duplicatePhotoMatchPreset: 'SAME_IMAGE' });
    await expectRevisions(0, 0);
  });

  it('advances across disable/re-enable and change/revert instead of reviving a prior epoch', async () => {
    await update({ antiDuplicateEnabled: false });
    await update({ antiDuplicateEnabled: true });
    await expectRevisions(2, 2);
    await update({ duplicateNearMatchEnabled: true });
    await update({ duplicateNearMatchEnabled: false });
    await expectRevisions(4, 4);
  });

  it.each<Prisma.ChatSettingsUpdateInput>([
    { duplicateCompareMode: 'TEXT' },
    { duplicatePhotoScope: 'CHAT' },
    { duplicateDetectionPreset: 'STRICT' },
    { duplicateIgnoreLinksEnabled: true },
    { duplicateIgnorePhonesEnabled: true },
    { duplicateNearMatchEnabled: true },
    { duplicateWarnWindowSec: 7200 },
    { duplicateWarnMaxCount: 3 },
    { duplicateBotMessageEnabled: true },
  ])(
    'advances history and authority on an effective matching or allowance change: %j',
    async (data) => {
      await update(data);
      await expectRevisions(1, 1);
    },
  );

  it('ignores inactive windows, thresholds and mute duration', async () => {
    await update({
      duplicateMuteWindowSec: 86400,
      duplicateBanWindowSec: 172800,
      duplicateMuteMaxCount: 10,
      duplicateBanMaxCount: 11,
      duplicateMuteDurationHours: 24,
      duplicateStartTimeMinutes: 1,
      duplicateEndTimeMinutes: 2,
      duplicateTimezone: 'Asia/Tokyo',
    });
    await expectRevisions(0, 0);
  });

  it('normalizes ignored preset options and equivalent exact comparison presets', async () => {
    await update({ duplicateDetectionPreset: 'STANDARD' });
    await expectRevisions(0, 0);
    await update({
      duplicateIgnoreLinksEnabled: true,
      duplicateIgnorePhonesEnabled: true,
      duplicateNearMatchEnabled: true,
    });
    await expectRevisions(0, 0);
    await update({ duplicateDetectionPreset: 'STRICT' });
    await expectRevisions(1, 1);
    await update({
      duplicateIgnoreLinksEnabled: false,
      duplicateIgnorePhonesEnabled: false,
      duplicateNearMatchEnabled: false,
    });
    await expectRevisions(1, 1);
  });

  it('does not invalidate TEXT history for an IMAGE-only scope change', async () => {
    await update({ duplicateCompareMode: 'TEXT' });
    await expectRevisions(1, 1);
    await update({ duplicatePhotoScope: 'CHAT' });
    await expectRevisions(1, 1);
    await update({ duplicateCompareMode: 'MESSAGE' });
    await expectRevisions(2, 2);
  });

  it('preserves history for sanction changes when the effective window and allowance stay equal', async () => {
    await update({ duplicateMuteEnabled: true, duplicateBanEnabled: true });
    await expectRevisions(0, 1);
    await update({ duplicateMuteDurationHours: 2 });
    await expectRevisions(0, 2);
    await update({ duplicateBotMessageEnabled: true, duplicateWarnMaxCount: 3 });
    await expectRevisions(0, 3);
    await update({ duplicateMuteMaxCount: 6, duplicateBanMaxCount: 8 });
    await expectRevisions(0, 3);
  });

  it('tracks the effective first enabled stage rather than every saved stage', async () => {
    await update({
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateMuteWindowSec: 3600,
      duplicateMuteMaxCount: 2,
    });
    await expectRevisions(0, 1);
    await update({ duplicateWarnWindowSec: 86400, duplicateWarnMaxCount: 10 });
    await expectRevisions(0, 1);
    await update({ duplicateMuteWindowSec: 7200 });
    await expectRevisions(1, 2);
    await update({ duplicateMuteMaxCount: 3 });
    await expectRevisions(2, 3);
  });

  it('uses daily schedule boundaries and ignores saved interval durations while DAILY', async () => {
    await update({ duplicateWindowMode: 'DAILY' });
    await expectRevisions(1, 1);
    await update({
      duplicateWarnWindowSec: 86400,
      duplicateMuteWindowSec: 172800,
      duplicateBanWindowSec: 604800,
      duplicateTimezone: 'europe/moscow',
    });
    await expectRevisions(1, 1);
    await update({ duplicateStartTimeMinutes: 600 });
    await expectRevisions(2, 2);
    await update({ duplicateTimezone: 'Asia/Tokyo' });
    await expectRevisions(3, 3);
    await update({ duplicateEndTimeMinutes: 1140 });
    await expectRevisions(4, 4);
  });

  it('compares normalized allowances against the runtime resolver for every reaction combination', async () => {
    for (let mask = 0; mask < 16; mask += 1) {
      for (const threshold of [-1, 2, 20, 99]) {
        const settings = await update({
          duplicateBotMessageEnabled: Boolean(mask & 1),
          duplicateWarnEnabled: Boolean(mask & 2),
          duplicateMuteEnabled: Boolean(mask & 4),
          duplicateBanEnabled: Boolean(mask & 8),
          duplicateWarnMaxCount: threshold,
          duplicateMuteMaxCount: threshold + 1,
          duplicateBanMaxCount: threshold + 2,
        });
        const [row] = await prisma.$queryRaw<
          Array<{
            signature: { history: { allowed_count: number; window_seconds: number } };
          }>
        >(Prisma.sql`
          SELECT chat_duplicate_policy_signature(settings) AS signature
          FROM chat_settings settings WHERE chat_id = ${chatId}
        `);
        const flow = resolveDuplicateFlowConfig(settings);
        expect(row.signature.history.allowed_count).toBe(flow.allowedCount);
        expect(row.signature.history.window_seconds).toBe(flow.windowSec);
      }
    }
  });

  it('preserves history for changes already clamped to the same allowance', async () => {
    await update({ duplicateWarnMaxCount: 99 });
    await expectRevisions(1, 1);
    await update({ duplicateWarnMaxCount: 100 });
    await expectRevisions(1, 1);
    await update({ duplicateWarnMaxCount: -1 });
    await expectRevisions(2, 2);
    await update({ duplicateWarnMaxCount: -2 });
    await expectRevisions(2, 2);
  });

  it('serializes concurrent effective changes and simultaneous no-ops on the same row', async () => {
    await Promise.all([
      update({ antiDuplicateEnabled: false }),
      update({ antiDuplicateEnabled: false, duplicatePolicyRevision: 0 }),
    ]);
    await expectRevisions(1, 1);
    await Promise.all([
      update({ duplicateIgnoreLinksEnabled: true }),
      update({ duplicateNearMatchEnabled: true }),
    ]);
    await expectRevisions(3, 3);
  });

  it('applies revisions to every row in a bulk settings writer', async () => {
    const otherChatId = `duplicate-policy-${randomUUID()}`;
    chatIds.push(otherChatId);
    await prisma.chat.create({ data: { id: otherChatId, title: 'Bulk policy regression' } });
    await prisma.chatSettings.create({ data: { chatId: otherChatId, ...baseline } });
    await prisma.chatSettings.updateMany({
      where: { chatId: { in: [chatId, otherChatId] } },
      data: { duplicateNearMatchEnabled: true },
    });
    const rows = await prisma.chatSettings.findMany({
      where: { chatId: { in: [chatId, otherChatId] } },
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId,
          duplicateHistoryRevision: 1,
          duplicatePolicyRevision: 1,
        }),
        expect.objectContaining({
          chatId: otherChatId,
          duplicateHistoryRevision: 1,
          duplicatePolicyRevision: 1,
        }),
      ]),
    );
  });
});
