import assert from 'node:assert/strict';
import test from 'node:test';
import { isInvalidPublisherEntitiesCursorError } from '../src/features/publications/use-publication-target-sources';
import { createApiRequestError } from '../src/lib/api-request-error';

test('publisher pagination reseeds only a stable invalid-cursor response', () => {
  assert.equal(
    isInvalidPublisherEntitiesCursorError(
      createApiRequestError(
        400,
        JSON.stringify({ code: 'PUBLISHER_ENTITIES_CURSOR_INVALID' }),
        'Курсор списка получателей недействителен.',
      ),
    ),
    true,
  );
  assert.equal(
    isInvalidPublisherEntitiesCursorError(
      createApiRequestError(400, JSON.stringify({ code: 'OTHER_BAD_REQUEST' }), 'Bad request'),
    ),
    false,
  );
  assert.equal(
    isInvalidPublisherEntitiesCursorError(
      createApiRequestError(
        503,
        JSON.stringify({ code: 'PUBLISHER_ENTITIES_CURSOR_INVALID' }),
        'Unavailable',
      ),
    ),
    false,
  );
  assert.equal(isInvalidPublisherEntitiesCursorError(new TypeError('Network failed')), false);
});
