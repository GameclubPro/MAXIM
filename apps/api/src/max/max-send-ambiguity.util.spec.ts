import { isAmbiguousMaxMutationError, isAmbiguousMaxSendError } from './max-send-ambiguity.util';

describe('MAX send ambiguity classification', () => {
  it.each([500, 501, 502, 503, 505, 599])('treats HTTP %s as ambiguous for sends', (status) => {
    expect(isAmbiguousMaxSendError({ response: { status } })).toBe(true);
  });

  it('keeps ordinary idempotent mutations retryable on HTTP 500', () => {
    expect(isAmbiguousMaxMutationError({ response: { status: 500 } })).toBe(false);
  });

  it.each([408, 504])('keeps HTTP %s ambiguous for every mutation', (status) => {
    expect(isAmbiguousMaxMutationError({ response: { status } })).toBe(true);
    expect(isAmbiguousMaxSendError({ response: { status } })).toBe(true);
  });
});
