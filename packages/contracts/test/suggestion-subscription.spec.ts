import { describe, expect, it } from 'vitest';
import { channelSettingsSchema } from '../src/core.js';
import {
  publisherEntityModuleSettingsSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
} from '../src/publisher.js';

describe('suggestion subscription settings', () => {
  it('preserves legacy Major behavior by default', () => {
    expect(channelSettingsSchema.parse({})).toMatchObject({
      postSuggestionsRequireSubscription: false,
      postSuggestionsDeleteOnUnsubscribe: false,
    });
  });
  it('accepts independent Publisher toggles and requires a revision', () => {
    expect(
      updatePublisherEntityModuleSettingsRequestSchema.parse({
        expectedRevision: 2,
        channelSuggestionsRequireSubscription: true,
        channelSuggestionsDeleteOnUnsubscribe: false,
      }),
    ).toMatchObject({ expectedRevision: 2, channelSuggestionsRequireSubscription: true });
    expect(
      updatePublisherEntityModuleSettingsRequestSchema.safeParse({
        channelSuggestionsRequireSubscription: true,
      }).success,
    ).toBe(false);
  });
  it('keeps old Publisher responses compatible', () => {
    expect(
      publisherEntityModuleSettingsSchema.parse({
        revision: 0,
        chatComments: null,
        autoRepliesEnabled: null,
        channelSuggestionsEnabled: false,
      }),
    ).toMatchObject({
      channelSuggestionsRequireSubscription: null,
      channelSuggestionsDeleteOnUnsubscribe: null,
    });
  });
});
