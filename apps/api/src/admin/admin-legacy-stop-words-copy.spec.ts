import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';

type AdminDependencies = ConstructorParameters<typeof AdminService>;
type StoredStopWords = { stopWordsPolicy: unknown; stopWordsMedia?: unknown };
type SourceSettings = Omit<ChatSettings, 'stopWordsPolicy'> &
  StoredStopWords & { stopWordsRevision: number; updatedAt: Date };

function createService(stored: StoredStopWords) {
  const sourceSettings: SourceSettings = {
    ...chatSettingsSchema.parse({}),
    ...stored,
    stopWordsRevision: 4,
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  };
  const prisma = {
    chat: {
      upsert: jest
        .fn<
          Promise<{ id: string; settings: SourceSettings }>,
          Parameters<AdminDependencies[0]['chat']['upsert']>
        >()
        .mockResolvedValue({ id: 'chat-1', settings: sourceSettings }),
    },
    chatSettings: {
      updateMany: jest
        .fn<
          Promise<{ count: number }>,
          Parameters<AdminDependencies[0]['chatSettings']['updateMany']>
        >()
        .mockResolvedValue({ count: 0 }),
      findUnique: jest
        .fn<
          Promise<SourceSettings | null>,
          Parameters<AdminDependencies[0]['chatSettings']['findUnique']>
        >()
        .mockResolvedValue(sourceSettings),
    },
    auditLog: {
      create: jest.fn<Promise<unknown>, Parameters<AdminDependencies[0]['auditLog']['create']>>(),
    },
  };
  const cache = {
    invalidate: jest
      .fn<
        ReturnType<AdminDependencies[2]['invalidate']>,
        Parameters<AdminDependencies[2]['invalidate']>
      >()
      .mockResolvedValue(undefined),
  } satisfies Pick<AdminDependencies[2], 'invalidate'>;
  const service = new AdminService(
    prisma as unknown as AdminDependencies[0],
    {} as AdminDependencies[1],
    cache as unknown as AdminDependencies[2],
    new ConfigService({ MAX_BOT_TOKEN: 'test-max-bot-token', DATABASE_URL: '' }),
  );
  const access = jest.spyOn(service, 'assertManagedEntityReadAccess').mockResolvedValue(undefined);
  const assignment = jest
    .spyOn(service, 'resolveChatSettingsReadBotAssignmentData')
    .mockResolvedValue({});
  return { service, prisma, sourceSettings, access, assignment };
}

describe('AdminService legacy stop-word section copy', () => {
  it.each([
    { name: 'policy', stopWordsPolicy: { version: 999, enabled: true } },
    {
      name: 'media',
      stopWordsPolicy: stopWordsPolicySchema.parse({ enabled: true }),
      stopWordsMedia: [],
    },
  ])(
    'rejects invalid $name storage before applying settings',
    async ({ name: _name, ...stored }) => {
      const { service, prisma, sourceSettings, access, assignment } = createService(stored);
      const apply = jest.spyOn(service, 'applySettingsToAllChats');
      const settingsOnlyRead = jest.spyOn(service, 'getSettings');
      await expect(
        service.applySettingsSectionToAllChats(
          'chat-1',
          { userId: 'admin-1', username: null, displayName: null, chatTitle: null },
          { section: 'stopWords', expectedSourceRevision: 4 },
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 4 },
      });
      expect(access).toHaveBeenCalledWith('chat-1', 'admin-1', 'chat');
      expect(assignment).toHaveBeenCalledWith('chat-1');
      expect(prisma.chat.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'chat-1' }, include: { settings: true } }),
      );
      expect(settingsOnlyRead).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(sourceSettings.stopWordsPolicy).toEqual(stored.stopWordsPolicy);
    },
  );
});
