import { PublisherAccessRefreshEvidenceService } from './publisher-access-refresh-evidence.service';

describe('durable Publisher bot proof diagnostics', () => {
  it('does not report a missing renewal deadline or create obligations for durable access', async () => {
    const createMany = jest.fn();
    const upsert = jest.fn();
    const service = new PublisherAccessRefreshEvidenceService(
      { publisherAccessRefreshObligation: { createMany, upsert } } as never,
      { deadlinePrioritiesEnabled: true } as never,
    );
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const previous = {
      publisherBotId: 'publik',
      status: 'ACTIVE' as const,
      botAccessState: 'CONFIRMED_ADMIN' as const,
      botAccessCheckedAt: new Date('2020-01-01'),
      botAccessExpiresAt: null,
    };
    await service.observeDue('publik', [{ ...previous, chatId: 'chat' }], new Date());
    await service.recordCommittedProof({
      chatId: 'chat',
      previous,
      probeStartedAt: new Date(),
      committedAt: new Date(),
      outcome: 'confirmed',
    });
    expect(createMany).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
