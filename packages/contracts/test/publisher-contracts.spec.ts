import { describe, expect, it } from 'vitest';
import { meSchema } from '../src/core.js';
import {
  publisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
} from '../src/publisher.js';
import { systemRuntimeProfileSchema } from '../src/system-core.js';

describe('publisher contracts', () => {
  it('projects a publisher mini app profile without bot identity details', () => {
    const me = meSchema.parse({
      userId: '42',
      username: null,
      displayName: null,
      profile: 'publisher',
      capabilities: ['publisher_workspace', 'publisher_entities', 'chat_comments'],
      homeRoute: '/publications',
    });

    expect(me).toMatchObject({
      profile: 'publisher',
      homeRoute: '/publications',
    });
    expect(me).not.toHaveProperty('launchBotId');
  });

  it('keeps readiness and policy explicit for every publisher target', () => {
    const response = publisherEntitiesResponseSchema.parse({
      items: [
        {
          id: 'channel-1',
          title: 'Новости',
          entityType: 'channel',
          policy: {
            publikEnabled: true,
            suggestionsViaPublik: false,
            revision: 0,
            updatedAt: null,
          },
          readiness: {
            state: 'setup_required',
            canPublish: false,
            canUseChatComments: false,
            canPublishSuggestions: false,
            blockerCode: 'bot_not_connected',
            checkedAt: null,
            retryAt: null,
          },
        },
      ],
    });

    expect(response.items[0]?.readiness.blockerCode).toBe('bot_not_connected');
  });

  it('requires an optimistic revision and at least one policy change', () => {
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.safeParse({ expectedRevision: 0 }).success,
    ).toBe(false);
    expect(
      updateManagedEntityPublicationPolicyRequestSchema.parse({
        expectedRevision: 2,
        publikEnabled: false,
      }),
    ).toEqual({ expectedRevision: 2, publikEnabled: false });
  });

  it('accepts the isolated publisher runtime profile', () => {
    expect(
      systemRuntimeProfileSchema.parse({
        appRole: 'publisher',
        serviceName: 'api-publisher',
        queueProfile: 'publisher-dispatch',
        queuePriority: 'publisher-dispatch',
        httpEnabled: false,
        ingressEnabled: false,
        adminEnabled: false,
        enqueueEnabled: false,
        moderationEnabled: false,
        actionEnabled: false,
        publisherEnabled: true,
        enabledQueues: [],
        dynamicLeasesMode: 'off',
        dynamicLeasesWorkerGroup: null,
        canaryShardIds: [],
        targetWebhookP95Ms: 400,
        generatedAt: '2026-08-26T00:00:00.000Z',
      }).publisherEnabled,
    ).toBe(true);
  });
});
