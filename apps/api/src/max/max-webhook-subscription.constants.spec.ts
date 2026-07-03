import {
  MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES,
  MAX_REQUIRED_WEBHOOK_UPDATE_TYPES,
} from './max-webhook-subscription.constants';

describe('MAX webhook subscription constants', () => {
  it('keeps product-required webhook updates as an intentional official subset', () => {
    expect(MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES).toEqual(
      expect.arrayContaining([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
    );
    expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toContain('bot_stopped');
    expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toContain('dialog_removed');
    expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toContain('message_removed');
  });
});
