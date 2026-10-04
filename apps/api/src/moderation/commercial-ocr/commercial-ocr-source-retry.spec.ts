import { MaxApiCircuitOpenError } from '../../max/max-client.service';
import { resolveCommercialOcrSourceRetry } from './commercial-ocr-source-retry';

describe('commercial OCR exact source retry classification', () => {
  it.each(['ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_HEADERS_TIMEOUT'])('retries %s', (code) => {
    expect(resolveCommercialOcrSourceRetry({ code })).toEqual({});
  });
  it.each([408, 429, 500, 502, 503, 504])('retries temporary HTTP %s', (status) => {
    expect(resolveCommercialOcrSourceRetry({ response: { status } })).toEqual({});
  });
  it.each([400, 401, 403, 404, 410, 422])('keeps HTTP %s terminal', (status) => {
    expect(resolveCommercialOcrSourceRetry({ response: { status } })).toBeNull();
  });
  it('keeps an explicit access denial terminal even with a timeout code', () => {
    expect(
      resolveCommercialOcrSourceRetry({ code: 'ETIMEDOUT', response: { status: 403 } }),
    ).toBeNull();
    expect(resolveCommercialOcrSourceRetry(new Error('timeout? unknown transport'))).toBeNull();
  });
  it('honors the longest valid Retry-After and the circuit cooldown', () => {
    expect(resolveCommercialOcrSourceRetry(new MaxApiCircuitOpenError('bot', 12_000))).toEqual({
      retryAfterMs: 12_000,
    });
    expect(
      resolveCommercialOcrSourceRetry({
        response: { status: 429, headers: { 'retry-after': '30' } },
        retryAfterMs: 12_000,
      }),
    ).toEqual({ retryAfterMs: 30_000 });
    const now = Date.parse('2026-10-05T10:00:00Z');
    expect(
      resolveCommercialOcrSourceRetry(
        { response: { status: 503, headers: { 'retry-after': 'Mon, 05 Oct 2026 10:00:20 GMT' } } },
        now,
      ),
    ).toEqual({ retryAfterMs: 20_000 });
  });
});
