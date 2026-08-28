import {
  MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES,
  MAX_EXTENDED_LIFECYCLE_WEBHOOK_UPDATE_TYPES,
  MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES,
  MAX_REQUIRED_WEBHOOK_UPDATE_TYPES,
  resolveRequiredWebhookUpdateTypes,
} from './max-webhook-subscription.constants';

describe('MAX webhook subscription constants', () => {
  it('keeps product-required webhook updates as an intentional official subset', () => {
    expect(MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES).toEqual(
      expect.arrayContaining([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
    );
    expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).toEqual(
      expect.arrayContaining(['bot_stopped', 'dialog_removed', 'message_removed']),
    );
    expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toContain('dialog_cleared');
    expect(MAX_KNOWN_OFFICIAL_WEBHOOK_UPDATE_TYPES).toEqual(
      expect.arrayContaining(['comment_created', 'comment_edited', 'comment_removed']),
    );
    for (const type of ['comment_created', 'comment_edited', 'comment_removed'] as const) {
      expect(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toContain(type);
    }
    expect(MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES).not.toEqual(
      expect.arrayContaining([...MAX_EXTENDED_LIFECYCLE_WEBHOOK_UPDATE_TYPES]),
    );
  });

  it('subscribes in shadow for observation while off omits extended lifecycle events', () => {
    expect(resolveRequiredWebhookUpdateTypes('shadow')).toEqual(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);
    expect(resolveRequiredWebhookUpdateTypes('off')).toEqual(
      MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES,
    );
    expect(resolveRequiredWebhookUpdateTypes('canary')).toEqual(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);
    expect(resolveRequiredWebhookUpdateTypes('on')).toEqual(MAX_REQUIRED_WEBHOOK_UPDATE_TYPES);
  });
});
