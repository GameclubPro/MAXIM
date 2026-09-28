import { managedRefreshBackoffMs } from './managed-refresh-backoff';

describe('managed refresh pressure', () => {
  it('uses token Retry-After and distinguishes infrastructure and permission errors', () => {
    expect(
      managedRefreshBackoffMs({ response: { status: 429, headers: { 'retry-after': '45' } } }),
    ).toBe(45_000);
    expect(
      managedRefreshBackoffMs({ response: { status: 429, headers: { 'retry-after': '900' } } }),
    ).toBe(900_000);
    expect(
      managedRefreshBackoffMs({ code: 'MAX_API_INTERNAL_RATE_LIMIT', retryAfterMs: 20_000 }),
    ).toBe(20_000);
    expect(managedRefreshBackoffMs({ response: { status: 503 } })).toBeNull();
    expect(managedRefreshBackoffMs({ response: { status: 403 } })).toBeNull();
  });
});
