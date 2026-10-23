import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';

describe('reverse statistics response limits', () => {
  afterEach(() => jest.restoreAllMocks());
  function remote() {
    const service = new StatisticsExchangeStatisticsService(
      {} as never,
      new ConfigService({ SVYAZKA_STATISTICS_EXPORT_TOKEN: 'synthetic-test-token' }),
      {} as never,
      {} as never,
    );
    return service as unknown as { remote(path: string): Promise<unknown> };
  }
  it('accepts a bounded grant response over128KiB for100 entity metadata records', async () => {
    const payload = {
      entities: Array.from({ length: 100 }, () => ({
        metadata: { description: 'x'.repeat(4000) },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(128 * 1024);
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    await expect(remote().remote(`/grants/${randomUUID()}`)).resolves.toEqual(payload);
  });
  it.each([
    [`/grants/${randomUUID()}`, 1024 * 1024],
    [`/grants/${randomUUID()}/statistics?entityId=-100&kind=CHANNEL`, 128 * 1024],
  ])('rejects oversized response at%s', async (path, limit) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ padding: 'x'.repeat(limit) }), { status: 200 }),
      );
    await expect(remote().remote(path)).rejects.toThrow('EXCHANGE_RESPONSE_LIMIT');
  });
});
