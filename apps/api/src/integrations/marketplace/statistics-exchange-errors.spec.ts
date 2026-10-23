import { ConflictException, ForbiddenException } from '@nestjs/common';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import {
  ExchangeProtocolError,
  ExchangeResponseError,
  classifyExchangeFailure,
  exchangeRetryAfter,
  exchangeRetryDelay,
} from './statistics-exchange-errors';

describe('statistics exchange operational failure boundary', () => {
  const now = Date.parse('2026-10-23T12:00:00.000Z');

  it('parses Retry-After seconds and HTTP dates without an unbounded peer delay', () => {
    expect(exchangeRetryAfter(' 120 ', now)).toBe(120_000);
    expect(exchangeRetryAfter('0', now)).toBe(0);
    expect(exchangeRetryAfter('Fri, 23 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(exchangeRetryAfter('9999999999', now)).toBe(86_400_000);
    expect(exchangeRetryAfter('Sat, 24 Oct 2026 12:01:00 GMT', now)).toBe(86_400_000);
  });

  it.each([
    null,
    '',
    '-1',
    '1.5',
    'Infinity',
    '2026-10-23',
    'Fri, invalid',
    '9'.repeat(129),
    'я'.repeat(65),
  ])('ignores an invalid or oversized Retry-After header %s', (value) =>
    expect(exchangeRetryAfter(value, now)).toBeNull(),
  );

  it('ignores elapsed dates and invalid clocks', () => {
    expect(exchangeRetryAfter('Fri, 23 Oct 2026 11:59:59 GMT', now)).toBeNull();
    expect(exchangeRetryAfter('10', NaN)).toBeNull();
  });

  it.each([
    [401, 'ACCESS_DENIED', true, true],
    [403, 'ACCESS_DENIED', true, true],
    [404, 'SNAPSHOT_EXPIRED', true, false],
    [410, 'SNAPSHOT_EXPIRED', true, false],
    [409, 'REVISION_CONFLICT', true, true],
    [412, 'REVISION_CONFLICT', true, true],
    [429, 'THROTTLED', false, false],
    [500, 'REMOTE_UNAVAILABLE', false, false],
    [503, 'REMOTE_UNAVAILABLE', false, false],
    [422, 'INVALID_PAYLOAD', true, false],
  ] as const)(
    'classifies HTTP %s without losing retry metadata',
    (status, code, resetStaging, recheckAccess) => {
      expect(classifyExchangeFailure(new ExchangeResponseError(status, 123_000))).toEqual({
        code,
        resetStaging,
        recheckAccess,
        retryAfterMs: 123_000,
      });
    },
  );

  it('preserves interrupted downloads on timeout and transport failures', () => {
    const errors = [
      new DOMException('private endpoint or response', 'TimeoutError'),
      new DOMException('private endpoint or response', 'AbortError'),
      new TypeError('private endpoint or response'),
      Object.assign(new Error('private endpoint or response'), { code: 'ECONNRESET' }),
      new Error('private endpoint or response', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }),
    ];
    expect(errors.map((error) => classifyExchangeFailure(error))).toEqual(
      ['TIMEOUT', 'TIMEOUT', 'TRANSPORT', 'TRANSPORT', 'TIMEOUT'].map((code) => ({
        code,
        resetStaging: false,
        recheckAccess: false,
        retryAfterMs: null,
      })),
    );
  });

  it('recognizes native errors across realms without accepting unbranded lookalikes', () => {
    const transport: unknown = runInNewContext('new TypeError("private peer details")');
    const payload: unknown = runInNewContext('new SyntaxError("private peer details")');
    expect(transport).not.toBeInstanceOf(Error);
    expect(payload).not.toBeInstanceOf(Error);
    expect(classifyExchangeFailure(transport).code).toBe('TRANSPORT');
    expect(classifyExchangeFailure(payload).code).toBe('INVALID_PAYLOAD');
    expect(classifyExchangeFailure({ name: 'TypeError', message: 'fetch failed' }).code).toBe(
      'UNKNOWN',
    );
  });

  it('classifies schema, JSON, checksum and exact protocol failures', () => {
    const invalid = z.string().safeParse(123);
    if (invalid.success) throw new Error('Expected schema fixture rejection');
    for (const error of [
      invalid.error,
      new SyntaxError('private response text'),
      new Error('EXCHANGE_DUPLICATE_ROW'),
      new Error('EXCHANGE_RESPONSE_LIMIT'),
      new ExchangeProtocolError('INVALID_PAYLOAD', 'EXCHANGE_IDENTITY_MISMATCH'),
    ]) {
      expect(classifyExchangeFailure(error)).toMatchObject({
        code: 'INVALID_PAYLOAD',
        resetStaging: true,
      });
    }
    expect(classifyExchangeFailure(new Error('EXCHANGE_CHECKSUM_MISMATCH'))).toMatchObject({
      code: 'CHECKSUM_MISMATCH',
      resetStaging: true,
    });
    expect(classifyExchangeFailure(new Error('EXCHANGE_DEADLINE'))).toMatchObject({
      code: 'TIMEOUT',
      resetStaging: false,
    });
  });

  it('keeps a download owned by another lease while fencing authority and revision changes', () => {
    for (const message of [
      'EXCHANGE_DOWNLOAD_LEASE_BUSY',
      'EXCHANGE_DOWNLOAD_LEASE_CHANGED',
      'EXCHANGE_AUTHORITY_CHECK_SUPERSEDED',
    ]) {
      expect(classifyExchangeFailure(new ConflictException(message))).toEqual({
        code: 'REVISION_CONFLICT',
        resetStaging: false,
        recheckAccess: false,
        retryAfterMs: null,
      });
    }
    expect(
      classifyExchangeFailure(
        new ExchangeProtocolError('REVISION_CONFLICT', 'EXCHANGE_DOWNLOAD_LEASE_CHANGED'),
      ),
    ).toMatchObject({
      resetStaging: false,
      recheckAccess: false,
    });
    for (const message of [
      'EXCHANGE_DOWNLOAD_AUTHORITY_CHANGED',
      'EXCHANGE_DOWNLOAD_CHANGED',
      'EXCHANGE_PAGE_CONFLICT',
    ]) {
      expect(classifyExchangeFailure(new ConflictException(message))).toMatchObject({
        code: 'REVISION_CONFLICT',
        resetStaging: true,
        recheckAccess: true,
      });
    }
    expect(classifyExchangeFailure(new ConflictException('Частные детали полномочий')).code).toBe(
      'REVISION_CONFLICT',
    );
    expect(classifyExchangeFailure(new ForbiddenException('Частные детали полномочий')).code).toBe(
      'ACCESS_DENIED',
    );
    expect(classifyExchangeFailure(new Error('EXCHANGE_DOWNLOAD_EXPIRED')).code).toBe(
      'SNAPSHOT_EXPIRED',
    );
  });

  it('returns only fixed operational fields for unknown errors and sanitizes its own error messages', () => {
    const privateMessage = 'https://private.example/token=secret, body=private response';
    const classified = classifyExchangeFailure(new Error(privateMessage));
    expect(classified).toEqual({
      code: 'UNKNOWN',
      resetStaging: false,
      recheckAccess: false,
      retryAfterMs: null,
    });
    expect(JSON.stringify(classified)).not.toContain(privateMessage);
    expect(classifyExchangeFailure('EXCHANGE_CHECKSUM_MISMATCH').code).toBe('UNKNOWN');
    expect(classifyExchangeFailure(new Error('constructor')).code).toBe('UNKNOWN');
    expect(classifyExchangeFailure({ name: 'TimeoutError' }).code).toBe('UNKNOWN');
    expect(classifyExchangeFailure(new DOMException('private details', 'SecurityError')).code).toBe(
      'UNKNOWN',
    );
    expect(new ExchangeProtocolError('INVALID_PAYLOAD', 'EXCHANGE_CHECKSUM_MISMATCH').message).toBe(
      'EXCHANGE_INVALID_PAYLOAD',
    );
    expect(new ExchangeResponseError(NaN).message).toBe('EXCHANGE_HTTP_INVALID');
    expect(new ExchangeResponseError(429, Infinity).retryAfterMs).toBeNull();
    expect(new ExchangeResponseError(429, 999_999_999).retryAfterMs).toBe(86_400_000);
  });

  it('backs off with bounded jitter and respects a separately capped Retry-After floor', () => {
    const failure = classifyExchangeFailure(new ExchangeResponseError(503));
    expect(exchangeRetryDelay(failure, 1, () => 0)).toBe(3750);
    expect(exchangeRetryDelay(failure, 1, () => 1)).toBe(6250);
    expect(exchangeRetryDelay(failure, 2, () => 0.5)).toBe(10_000);
    expect(exchangeRetryDelay(failure, 100, () => 1)).toBe(300_000);
    expect(
      exchangeRetryDelay(
        classifyExchangeFailure(new ExchangeResponseError(429, 600_000)),
        1,
        () => 0,
      ),
    ).toBe(600_000);
    expect(
      exchangeRetryDelay(
        classifyExchangeFailure(new Error('EXCHANGE_CHECKSUM_MISMATCH')),
        1,
        () => 0.5,
      ),
    ).toBe(300_000);
  });

  it('always returns a finite bounded delay for damaged retry counters or random samples', () => {
    const failure = classifyExchangeFailure(new TypeError('fetch failed'));
    for (const attempts of [NaN, Infinity, -Infinity, -1, 0, 0.5, 20]) {
      for (const sample of [NaN, Infinity, -Infinity, -1, 0, 1, 2]) {
        const delay = exchangeRetryDelay(failure, attempts, () => sample);
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(300_000);
      }
    }
  });
});
