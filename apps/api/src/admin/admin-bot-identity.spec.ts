import { resolveAdminBotUserId } from './admin-bot-identity';
import type { MaxBotRegistryService, MaxBotDefinition } from '../max/max-bot-registry.service';
import type { MaxClientService } from '../max/max-client.service';

function fixture(contactId: string | null = '123456') {
  const bot: MaxBotDefinition = {
    id: 'exact-bot',
    contactId,
    label: 'Bot',
    characterName: 'Bot',
    speechPersona: 'neutral',
    token: 'fixture-only',
    tokenValidationSecrets: [],
    webhookSecretPath: 'fixture-only',
    webhookHeaderSecret: 'fixture-only',
    webhookHeaderSecrets: [],
    state: 'active',
    ownershipWeight: 1,
    visibleInAdmin: true,
    isDefault: true,
    webhookUrl: null,
    maskedWebhookUrl: null,
  };
  const registry = {
    getBotById: jest.fn((id: string | null | undefined) => (id === bot.id ? bot : null)),
  } satisfies Pick<MaxBotRegistryService, 'getBotById'>;
  const maxClient = {
    getCurrentChatMemberAccess: jest
      .fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >()
      .mockRejectedValue(new Error('unavailable')),
  } satisfies Pick<MaxClientService, 'getCurrentChatMemberAccess'>;
  return { registry, maxClient, onUnavailable: jest.fn(), chatId: 'chat', botId: bot.id };
}

describe('bot identity for administrator recipient filtering', () => {
  it('uses the exact configured numeric contact without spending a membership request', async () => {
    const f = fixture();
    expect(await resolveAdminBotUserId(f)).toBe('123456');
    expect(f.registry.getBotById).toHaveBeenCalledWith('exact-bot');
    expect(f.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it.each([null, 'alias_bot', '123\n', ''])(
    'keeps the actual access lookup when contact identity is absent or invalid: %s',
    async (contact) => {
      const f = fixture(contact);
      expect(await resolveAdminBotUserId(f)).toBeNull();
      expect(f.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith('chat', {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        botId: 'exact-bot',
      });
      expect(f.onUnavailable).toHaveBeenCalledTimes(1);
    },
  );

  it('never borrows the default bot contact for an unknown bot or implicit request context', async () => {
    const f = fixture();
    expect(await resolveAdminBotUserId({ ...f, botId: 'other-bot' })).toBeNull();
    expect(await resolveAdminBotUserId({ ...f, botId: undefined })).toBeNull();
    expect(f.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
  });
});
