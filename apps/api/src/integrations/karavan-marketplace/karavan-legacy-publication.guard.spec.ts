import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MaxActionJob } from '../../max/max-client.service';
import { assertKaravanLegacyPublication } from './karavan-legacy-publication.guard';

describe('queued legacy Karavan publication retirement', () => {
  const config = new ConfigService({
    KARAVAN_STOREFRONT_RELAY_ENABLED: true,
    KARAVAN_API_BASE_URL: 'https://synthetic.example/api',
    KARAVAN_INTEGRATION_TOKEN: 'synthetic-only',
  });
  const enrollment = jest.fn();
  const prisma = {
    karavanMarketplaceChatEnrollment: { findUnique: enrollment },
  } as unknown as PrismaService;
  const job = {
    attempt: 0,
    idempotencyKey: 'synthetic-legacy',
    createdAt: new Date().toISOString(),
    actionType: 'SEND_MESSAGE',
    chatId: '-123',
    ledgerContext: {
      karavanStorefrontRelay: {
        storefrontOwnerUserId: '123',
        storeId: 'store1',
        variant: 'storefront',
      },
    },
    options: {
      buttons: [
        [{ type: 'link', text: 'Витрина', url: 'https://max.ru/synthetic?startapp=store1' }],
      ],
    },
  } as MaxActionJob;
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    enrollment.mockReset().mockResolvedValue(null);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          exists: true,
          store: { id: 'store1', url: 'https://max.ru/synthetic?startapp=store1' },
        }),
      ),
    );
  });
  afterEach(() => fetchSpy.mockRestore());
  it('uses a fresh authoritative lookup for every attempt', async () => {
    await assertKaravanLegacyPublication(config, prisma, job);
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 409 }));
    await expect(assertKaravanLegacyPublication(config, prisma, job)).rejects.toThrow(
      'Для публикации выберите магазин чата',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
  it('blocks old jobs for a chat with durable enrollment before making remote calls', async () => {
    enrollment.mockResolvedValue({ chatId: '-123' });
    await expect(assertKaravanLegacyPublication(config, prisma, job)).rejects.toThrow(
      'Для этого чата',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rechecks enrollment after the remote lookup', async () => {
    enrollment.mockResolvedValueOnce(null).mockResolvedValueOnce({ chatId: '-123' });
    await expect(assertKaravanLegacyPublication(config, prisma, job)).rejects.toThrow(
      'Для этого чата',
    );
  });
  it.each([403, 409, 503])(
    'does not publish on authoritative HTTP %s, including directory messages',
    async (status) => {
      fetchSpy.mockResolvedValue(new Response('{}', { status }));
      await expect(
        assertKaravanLegacyPublication(config, prisma, {
          ...job,
          ledgerContext: {
            karavanStorefrontRelay: {
              storefrontOwnerUserId: '123',
              storeId: null,
              variant: 'directory',
            },
          },
        }),
      ).rejects.toThrow();
    },
  );
  it('cannot retarget a queued storefront when the selected legacy business changes', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          exists: true,
          store: { id: 'store2', url: 'https://max.ru/synthetic?startapp=store2' },
        }),
      ),
    );
    await expect(assertKaravanLegacyPublication(config, prisma, job)).rejects.toThrow(
      'Витрина изменилась',
    );
  });
});
