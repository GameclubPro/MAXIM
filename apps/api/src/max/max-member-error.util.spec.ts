import { hasMaxInsufficientRightsMessage } from './max-member-error.util';

describe('hasMaxInsufficientRightsMessage', () => {
  it.each([
    'User already deleted or bot has insufficient rights',
    'Bot does not have sufficient rights',
    "Bot doesn't have sufficient rights",
    'Bot does not have enough rights',
  ])('recognizes a negative MAX rights response: %s', (message) => {
    expect(hasMaxInsufficientRightsMessage(message)).toBe(true);
  });

  it.each([
    'Bot has sufficient rights',
    'Bot rights are sufficient',
    'Sufficient rights confirmed',
  ])('does not classify an affirmative rights message as a denial: %s', (message) => {
    expect(hasMaxInsufficientRightsMessage(message)).toBe(false);
  });
});
