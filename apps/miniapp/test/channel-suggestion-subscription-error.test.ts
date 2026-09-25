import assert from 'node:assert/strict';
import test from 'node:test';
import { describeSuggestionSubscriptionError } from '../src/lib/channel-suggestion-subscription-error';

test('explains subscription rejection without surfacing arbitrary backend details', () => {
  assert.equal(
    describeSuggestionSubscriptionError(
      Object.assign(new Error('private diagnostics'), { code: 'SUGGESTION_SUBSCRIPTION_REQUIRED' }),
    ),
    'Чтобы предложить пост, подпишитесь на канал и повторите отправку.',
  );
  assert.equal(describeSuggestionSubscriptionError(new Error('forbidden')), null);
});
