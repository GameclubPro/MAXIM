import { processTargetedPublisherPublicationBroadcasts } from './publisher-publication-targeted-dispatch';

describe('Publisher targeted dispatch latency', () => {
  afterEach(() => jest.useRealTimers());

  function fixture() {
    const processOccurrence = jest
      .fn()
      .mockResolvedValue({ sentChatIds: ['chat'], failedChatIds: [] });
    const findMany = jest.fn().mockResolvedValue([{ id: 'broadcast' }]);
    const options = {
      context: { prisma: { managedBroadcast: { findMany } }, logger: { warn: jest.fn() } } as never,
      dispatchProfile: 'PUBLIK_V1' as const,
      publicationId: 'publication',
      reason: 'immediate' as const,
      processOccurrence,
    };
    return { options, processOccurrence, findMany };
  }

  it('yields a large audience instead of occupying the wakeup worker for 100 passes', async () => {
    const { options, processOccurrence } = fixture();
    await processTargetedPublisherPublicationBroadcasts(options);
    expect(processOccurrence).toHaveBeenCalledTimes(4);
    expect(processOccurrence).toHaveBeenCalledWith(
      expect.objectContaining({ automaticDeliveryQuantum: 4 }),
    );
  });

  it('yields after a slow durable attempt without interrupting or duplicating it', async () => {
    jest.useFakeTimers();
    const { options, processOccurrence, findMany } = fixture();
    processOccurrence.mockImplementation(async () => {
      jest.setSystemTime(Date.now() + 6_000);
      return { sentChatIds: ['chat'], failedChatIds: [] };
    });
    await processTargetedPublisherPublicationBroadcasts(options);
    expect(processOccurrence).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
