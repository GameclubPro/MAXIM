import { UnrecoverableError } from 'bullmq';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  assertPublisherSuggestionDeliveryReady,
  canRecoverPublisherSuggestionDelivery,
} from './publisher-suggestion-setup-block';

function fixture(code = 'module_disabled') {
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    auditLog: {
      findUnique: jest.fn().mockResolvedValue({
        chatId: '-1',
        action: 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION',
        payload: {
          type: 'suggest',
          reviewStatus: 'pending',
          publisherAdminDeliverySetupBlock: { version: 1, botId: 'publisher', code },
        },
      }),
    },
  };
  const readiness = {
    assertEntityReady: jest
      .fn()
      .mockRejectedValue(new PublisherSetupRequiredException(['-1'], code)),
  };
  return {
    prisma,
    readiness,
    params: {
      prisma: prisma as never,
      readiness: readiness as never,
      auditLogId: 'suggestion',
      chatId: '-1',
      requiredBotId: 'publisher',
      setupBlockPresent: true,
    },
  };
}

describe('Publisher suggestion pre-dispatch setup blocks', () => {
  it.each(['module_disabled', 'write_permission_missing'])(
    'persists %s before stopping retries and recovers only with current exact-bot readiness',
    async (code) => {
      const f = fixture(code);
      await expect(assertPublisherSuggestionDeliveryReady(f.params)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(1);
      await expect(canRecoverPublisherSuggestionDelivery(f.params)).resolves.toBe(false);
      f.readiness.assertEntityReady.mockResolvedValue({ requiredBotId: 'wrong-bot' });
      await expect(canRecoverPublisherSuggestionDelivery(f.params)).resolves.toBe(false);
      f.readiness.assertEntityReady.mockResolvedValue({ requiredBotId: 'publisher' });
      await expect(canRecoverPublisherSuggestionDelivery(f.params)).resolves.toBe(true);
      await assertPublisherSuggestionDeliveryReady(f.params);
      expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'bot_access_expired',
    'bot_access_unconfirmed',
    'route_quarantined',
    'publisher_runtime_unavailable',
  ])('retains normal retry for %s', async (code) => {
    const f = fixture(code);
    await expect(assertPublisherSuggestionDeliveryReady(f.params)).rejects.toBeInstanceOf(
      PublisherSetupRequiredException,
    );
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('does not classify copied fields or persistence errors as proven setup blocks', async () => {
    const f = fixture();
    const forged = Object.assign(new Error('ambiguous send'), { blockerCode: 'module_disabled' });
    f.readiness.assertEntityReady.mockRejectedValueOnce(forged);
    await expect(assertPublisherSuggestionDeliveryReady(f.params)).rejects.toBe(forged);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    const storage = new Error('database unavailable');
    f.prisma.$executeRaw.mockRejectedValue(storage);
    await expect(assertPublisherSuggestionDeliveryReady(f.params)).rejects.toBe(storage);
  });

  it('does not reopen terminal reviews or another bot marker on repeated recovery', async () => {
    const f = fixture();
    const row = await f.prisma.auditLog.findUnique();
    row.payload.reviewStatus = 'published';
    await expect(canRecoverPublisherSuggestionDelivery(f.params)).resolves.toBe(false);
    row.payload.reviewStatus = 'pending';
    row.payload.publisherAdminDeliverySetupBlock.botId = 'another';
    await expect(canRecoverPublisherSuggestionDelivery(f.params)).resolves.toBe(false);
    expect(f.readiness.assertEntityReady).not.toHaveBeenCalled();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
