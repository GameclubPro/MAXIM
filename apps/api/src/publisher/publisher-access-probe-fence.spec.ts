import {
  publisherAccessProbeLifecycleSuperseded,
  publisherAccessProbeLifecycleWhere,
} from './publisher-access-probe-fence';

describe('Publisher access probe lifecycle fence', () => {
  const startedAt = new Date(1_000);
  it.each([
    'message_created',
    'message_edited',
    'message_removed',
    'message_callback',
    'chat_title_changed',
  ])('does not let passive %s traffic starve verification', (lifecycleEventType) => {
    expect(
      publisherAccessProbeLifecycleSuperseded(
        { lifecycleEventType, lifecycleEventAt: new Date(2_000) },
        startedAt,
      ),
    ).toBe(false);
    expect(publisherAccessProbeLifecycleWhere(startedAt).OR).toContainEqual({
      lifecycleEventType: { in: expect.arrayContaining([lifecycleEventType]) },
    });
  });
  it.each(['bot_added', 'bot_removed', 'user_added', 'user_removed', 'unknown_event', null])(
    'keeps newer %s lifecycle changes fenced',
    (lifecycleEventType) => {
      expect(
        publisherAccessProbeLifecycleSuperseded(
          { lifecycleEventType, lifecycleEventAt: new Date(2_000) },
          startedAt,
        ),
      ).toBe(true);
      expect(
        publisherAccessProbeLifecycleSuperseded(
          { lifecycleEventType, lifecycleEventAt: new Date(500) },
          startedAt,
        ),
      ).toBe(false);
    },
  );
});
