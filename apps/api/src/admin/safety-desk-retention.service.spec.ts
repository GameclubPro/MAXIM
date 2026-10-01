import { SafetyDeskRetentionService } from './safety-desk-retention.service';

function setup() {
  const prisma = {
    messageRetentionPolicy: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    messageRetentionQuota: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const store = {
    allows: jest.fn().mockReturnValue(true),
    mode: 'off',
    reopenTerminalCandidate: jest.fn().mockResolvedValue(true),
  };
  const capabilities = { assertChatSettingsBotCapabilities: jest.fn() };
  const service = new SafetyDeskRetentionService(
    prisma as never,
    store as never,
    capabilities as never,
  );
  const body = {
    messageId: 'mid',
    activationId: 'activation',
    expectedRevision: 5,
    intentId: 'intent',
    expectedIntentUpdatedAt: '2026-10-01T10:00:00.000Z',
    expectedAttemptCount: 3,
  };
  return { service, prisma, store, capabilities, body };
}
describe('closed retention operator boundary', () => {
  it('uses bounded keyset policy paging and exactly 32 quota slots', async () => {
    const { service, prisma } = setup();
    await expect(service.runtime('-123')).resolves.toMatchObject({
      items: [],
      nextAfter: null,
      mode: 'off',
    });
    expect(prisma.messageRetentionPolicy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { chatId: { gt: '-123' } },
        take: 51,
        orderBy: { chatId: 'asc' },
      }),
    );
    expect(prisma.messageRetentionQuota.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 32 }),
    );
  });
  it('refuses invalid identifiers and unknown input before reads or access probes', async () => {
    const { service, store, capabilities, body, prisma } = setup();
    await expect(service.runtime('bad')).rejects.toMatchObject({ status: 400 });
    await expect(service.retry('-1', 'owner', { ...body, force: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(store.reopenTerminalCandidate).not.toHaveBeenCalled();
    expect(capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
    expect(prisma.messageRetentionPolicy.findMany).not.toHaveBeenCalled();
  });
  it('does not reopen outside current execution authority', async () => {
    const { service, store, capabilities, body } = setup();
    store.allows.mockReturnValue(false);
    await expect(service.retry('-1', 'owner', body)).rejects.toMatchObject({ status: 400 });
    expect(capabilities.assertChatSettingsBotCapabilities).not.toHaveBeenCalled();
    expect(store.reopenTerminalCandidate).not.toHaveBeenCalled();
  });
  it('forces fresh capability checks and delegates exact versions to the atomic store', async () => {
    const { service, store, capabilities, body } = setup();
    jest
      .spyOn(service, 'preview')
      .mockResolvedValue({ chatId: '-1', revision: 5, activationId: 'activation', items: [] });
    await service.retry('-1', 'owner', body);
    expect(capabilities.assertChatSettingsBotCapabilities).toHaveBeenCalledWith(
      '-1',
      expect.any(Array),
      { forceLive: true },
    );
    expect(store.reopenTerminalCandidate).toHaveBeenCalledWith({
      ...body,
      chatId: '-1',
      expectedIntentUpdatedAt: new Date(body.expectedIntentUpdatedAt),
      actorUserId: 'owner',
    });
  });
  it('preserves a conflict and does not publish a success snapshot when CAS fails', async () => {
    const { service, store, body } = setup();
    const preview = jest.spyOn(service, 'preview');
    store.reopenTerminalCandidate.mockResolvedValue(false);
    await expect(service.retry('-1', 'owner', body)).rejects.toMatchObject({ status: 409 });
    expect(preview).not.toHaveBeenCalled();
  });
});
