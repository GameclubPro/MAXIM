import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { registerStatsHttpLimits } from './stats-http-limits';
describe('central statistics HTTP streaming byte boundary', () => {
  it('rejects excessive whitespace including chunked payload before handler but preserves independent routes', async () => {
    const app = Fastify({ bodyLimit: 1_000_000 });
    registerStatsHttpLimits(app);
    const handler = jest.fn(() => ({ ok: true }));
    app.post('/api/v1/internal/statistics/ingest', handler);
    app.post('/independent', handler);
    const payload = ' '.repeat(65_537) + '{}';
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/internal/statistics/ingest',
          headers: { 'content-type': 'application/json' },
          payload,
        })
      ).statusCode,
    ).toBe(413);
    expect(handler).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/internal/statistics/ingest',
          headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          payload: Readable.from([payload.slice(0, 32000), payload.slice(32000)]),
        })
      ).statusCode,
    ).toBe(413);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/independent',
          headers: { 'content-type': 'application/json' },
          payload,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });
});
