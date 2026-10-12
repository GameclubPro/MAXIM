import {
  applyManagedBotPermissionEvent,
  BOT_PERMISSION_CHANGE_UPDATE,
} from './managed-bot-permission-event';
import { WebhookParser } from '../webhook/webhook.parser';

describe('MAX bot permission events', () => {
  function fixture() {
    const at = new Date(Date.now() - 1000);
    const binding = {
      publisherBotId: 'publik',
      status: 'ACTIVE',
      botAccessState: 'CONFIRMED_ADMIN',
      botAccessCheckedAt: new Date(+at - 1000),
      botAccessSource: 'explicit_start',
      lifecycleEventAt: new Date(+at - 2000),
      lifecycleEventType: 'bot_added',
      permissionsSnapshot: { isAdmin: true, permissionsKnown: true, permissions: ['write'] },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-1' }]),
      $transaction: jest.fn(),
      publisherEntityBinding: {
        findUnique: jest.fn().mockResolvedValue(binding),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((fn) => fn(prisma));
    const links = { recordBotAccessProbe: jest.fn().mockResolvedValue(true) };
    const registry = {
      getPublisherBotDescriptor: () => ({ id: 'publik', contactId: '200' }),
      resolveBotIdFromUserId: (id: string) => (id === '100' ? 'major' : null),
    };
    const parse = (raw = {}, botId = 'major') =>
      new WebhookParser().parse(
        {
          update_type: BOT_PERMISSION_CHANGE_UPDATE,
          timestamp: +at,
          chat_id: -1,
          user_id: 42,
          bot_id: botId === 'major' ? 100 : 200,
          is_channel: false,
          is_admin: false,
          permissions: null,
          ...raw,
        },
        { botId },
      );
    const run = (raw = {}, botId = 'major') =>
      applyManagedBotPermissionEvent({
        update: parse(raw, botId),
        prisma: prisma as never,
        links: links as never,
        registry: registry as never,
      });
    return { at, binding, prisma, links, parse, run };
  }
  it('parses documented fields and applies a denial only to the receiving bot', async () => {
    const f = fixture();
    expect(f.parse().message?.chatId).toBe('-1');
    await f.run();
    expect(f.links.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: '-1',
        botId: 'major',
        checkedAt: f.at,
        access: expect.objectContaining({ isAdmin: false }),
        source: 'webhook_bot_admin_permissions_changed',
      }),
    );
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([
    { bot_id: 42 },
    { bot_id: 200 },
    { is_admin: 'false' },
    { is_channel: null },
    { is_admin: true, permissions: null },
    { timestamp: Date.now() + 60_000 },
  ])('ignores ambiguous/foreign evidence %j', async (raw) => {
    const f = fixture();
    await f.run(raw);
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
  });
  it('preserves the exact permission list without consulting MAX', async () => {
    const f = fixture();
    await f.run({ is_admin: true, permissions: ['read_all_messages', 'write'] });
    expect(f.links.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        access: expect.objectContaining({
          isAdmin: true,
          permissionsKnown: true,
          permissions: ['read_all_messages', 'write'],
        }),
      }),
    );
  });
  it('persists Publisher demotion under the parent lock without touching moderator membership', async () => {
    const f = fixture();
    await f.run({}, 'publik');
    expect(f.prisma.publisherEntityBinding.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botAccessState: 'CONFIRMED_MEMBER',
          lifecycleEventAt: f.at,
        }),
      }),
    );
    expect(f.links.recordBotAccessProbe).not.toHaveBeenCalled();
  });
  it('rejects older Publisher events and never passively reactivates denial', async () => {
    const f = fixture();
    f.binding.botAccessCheckedAt = new Date(+f.at + 1);
    await f.run({}, 'publik');
    expect(f.prisma.publisherEntityBinding.update).not.toHaveBeenCalled();
    f.binding.botAccessCheckedAt = new Date(+f.at - 1000);
    f.binding.botAccessState = 'DENIED';
    await f.run({ is_admin: true, permissions: ['write'] }, 'publik');
    expect(f.prisma.publisherEntityBinding.update).not.toHaveBeenCalled();
  });
});
