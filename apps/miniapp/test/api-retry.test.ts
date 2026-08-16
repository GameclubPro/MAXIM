import assert from 'node:assert/strict';
import test from 'node:test';
import { createApiRequestError } from '../src/lib/api-request-error';
import {
  getApiErrorStatus,
  isTerminalApiClientError,
  isTransientApiError,
  shouldRetryTransientApiError,
} from '../src/lib/api-retry';

function createHttpError(status: number) {
  return createApiRequestError(status, JSON.stringify({ statusCode: status }), `HTTP ${status}`);
}

test('API status detection rejects unrelated and malformed errors', () => {
  assert.equal(getApiErrorStatus(Object.assign(new Error('unrelated'), { status: 401 })), null);
  assert.equal(getApiErrorStatus({ name: 'ApiRequestError', status: 401 }), null);

  for (const status of [99, 600, Number.NaN, 401.5, '401']) {
    assert.equal(
      getApiErrorStatus(Object.assign(new Error('malformed'), { name: 'ApiRequestError', status })),
      null,
    );
  }

  assert.equal(getApiErrorStatus(createHttpError(503)), 503);
});

test('terminal client errors are never retried by the shared predicate', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const error = createHttpError(status);
    assert.equal(isTerminalApiClientError(error), true);
    assert.equal(shouldRetryTransientApiError(0, error, 7), false);
  }
});

test('shared retry predicate keeps bounded retries for transient failures', () => {
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    const error = createHttpError(status);
    assert.equal(isTransientApiError(error), true);
    assert.equal(shouldRetryTransientApiError(0, error, 1), true);
    assert.equal(shouldRetryTransientApiError(1, error, 1), false);
  }

  assert.equal(shouldRetryTransientApiError(0, new TypeError('Failed to fetch'), 1), true);
  assert.equal(
    shouldRetryTransientApiError(0, new DOMException('aborted', 'AbortError'), 1),
    false,
  );
});
