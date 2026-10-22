import { describe, expect, it } from 'vitest';
import * as core from '../src/core.js';
import * as root from '../src/index.js';
import * as settings from '../src/settings.js';
import * as broadcast from '../src/broadcast.js';
import * as fields from '../src/settings-field-schemas.js';
import * as channel from '../src/channel-settings.js';
import * as channelFields from '../src/channel-settings-field-schemas.js';
import * as buttons from '../src/broadcast-buttons.js';
import * as summary from '../src/managed-broadcast-summary.js';
import * as schedule from '../src/broadcast-schedule-fields.js';
import * as message from '../src/settings-message-field-schemas.js';
import * as common from '../src/broadcast-common.js';
import { channelPostSignatureSettingsSchema } from '../src/channel-post-signature.js';
import { managedEntityHeaderSchema } from '../src/managed-entities.js';

function broadcastFixture() {
  return {
    id: 'broadcast-1',
    status: 'ACTIVE',
    textPreview: 'Новости',
    textLength: 7,
    applyToAllChats: false,
    targetChats: 1,
    targetPreviews: [{ id: 'channel-1', title: 'Канал' }],
    hasImage: false,
    buttons: [{ text: ' Читать ', url: ' https://example.com/post ' }],
    buttonEnabled: true,
    scheduledSlots: ['2026-10-22T15:00:00+03:00'],
    nextSendAt: '2026-10-22T15:00:00+03:00',
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    sentCount: 0,
    currentOccurrence: 1,
    deliveredChats: 0,
    failedChats: 0,
    pendingChats: 1,
    blockedChats: 0,
    failureBreakdown: { transient: 0, permanentTarget: 0, quarantined: 0, unknown: 0 },
    canRetry: false,
    remainingCount: 1,
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
    lastError: null,
  };
}
function screenFixture() {
  return {
    settings: {},
    postSignature: {},
    header: {
      id: 'channel-1',
      title: 'Канал',
      entityType: 'channel',
      link: null,
      participantsCount: null,
    },
    managedBroadcasts: [broadcastFixture()],
  };
}

describe('canonical channel screen and button partitions', () => {
  it('preserves screen and channel field identities through every public facade', () => {
    for (const facade of [core, root, settings]) {
      expect(facade.channelSettingsScreenResponseSchema).toBe(
        channel.channelSettingsScreenResponseSchema,
      );
      expect(facade.channelSettingsSchema).toBe(channelFields.channelSettingsSchema);
      expect(facade.channelSuggestionEntryModeSchema).toBe(
        channelFields.channelSuggestionEntryModeSchema,
      );
    }
    expect(channel.channelSettingsSchema).toBe(channelFields.channelSettingsSchema);
    expect(channel.channelSuggestionEntryModeSchema).toBe(
      channelFields.channelSuggestionEntryModeSchema,
    );
    expect(channel.channelSettingsScreenResponseSchema.shape.settings).toBe(
      channelFields.channelSettingsSchema,
    );
    expect(channel.channelSettingsScreenResponseSchema.shape.postSignature).toBe(
      channelPostSignatureSettingsSchema,
    );
    expect(channel.channelSettingsScreenResponseSchema.shape.header).toBe(
      managedEntityHeaderSchema,
    );
  });

  it('shares canonical summary validators across screen, chat and publishing entry points', () => {
    for (const name of [
      'managedBroadcastSummarySchema',
      'managedBroadcastTargetPreviewSchema',
      'managedBroadcastStatusSchema',
      'managedBroadcastFailureBreakdownSchema',
    ] as const) {
      expect(core[name]).toBe(summary[name]);
      expect(root[name]).toBe(summary[name]);
      expect(broadcast[name]).toBe(summary[name]);
    }
    expect(channel.channelSettingsScreenResponseSchema.shape.managedBroadcasts.element).toBe(
      summary.managedBroadcastSummarySchema,
    );
    expect(core.chatSettingsScreenResponseSchema.shape.managedBroadcasts.unwrap().element).toBe(
      summary.managedBroadcastSummarySchema,
    );
  });

  it('retains nonempty publishing summaries, date normalization and legacy defaults in channel screens', () => {
    const result = channel.channelSettingsScreenResponseSchema.parse(screenFixture());
    const item = result.managedBroadcasts[0]!;
    expect(item).toEqual(summary.managedBroadcastSummarySchema.parse(broadcastFixture()));
    expect(item.buttons).toEqual([{ text: 'Читать', url: 'https://example.com/post' }]);
    expect(item.scheduledSlots).toEqual(['2026-10-22T12:00:00.000Z']);
    expect(item.nextSendAt).toBe('2026-10-22T12:00:00.000Z');
    expect(item.scheduleMode).toBe('legacy');
    expect(item.scheduleTimezone).toBe('Europe/Moscow');
    expect(item.targetMode).toBe('current');
    expect(item.targetPreviews[0]).toMatchObject({
      entityType: 'chat',
      link: null,
      avatarUrl: null,
    });
    expect(item.imageCount).toBe(0);
    expect(item.hasVideo).toBe(false);
    expect(result.settings.postSuggestionsEntryMode).toBe('BOT');
    expect(result.postSignature.presentation).toBe('signature');
    expect(
      channel.channelSettingsScreenResponseSchema.safeParse({
        ...screenFixture(),
        managedBroadcasts: undefined,
      }).success,
    ).toBe(false);
    expect(
      channel.channelSettingsScreenResponseSchema.safeParse({
        ...screenFixture(),
        managedBroadcasts: [{ ...broadcastFixture(), status: 'UNKNOWN' }],
      }).success,
    ).toBe(false);
  });

  it('keeps timezone and date helpers canonical while preserving schedule inference', () => {
    expect(fields.broadcastScheduleTimezoneSchema).toBe(schedule.broadcastScheduleTimezoneSchema);
    expect(fields.isValidIanaTimeZone).toBe(schedule.isValidIanaTimeZone);
    expect(fields.chatSettingsFieldsSchema.shape.duplicateTimezone).toBe(
      schedule.broadcastScheduleTimezoneSchema,
    );
    expect(schedule.broadcastScheduleTimezoneSchema.parse(undefined)).toBe('Europe/Moscow');
    expect(schedule.broadcastScheduleTimezoneSchema.safeParse('Invalid/Timezone').success).toBe(
      false,
    );
    expect(schedule.broadcastDateTimeSchema.parse(new Date('2026-10-22T12:00:00Z'))).toBe(
      '2026-10-22T12:00:00.000Z',
    );
    expect(schedule.broadcastDateTimeSchema.safeParse('yesterday').success).toBe(false);
    expect(schedule.inferBroadcastScheduleMode({ scheduledSlots: ['2026-10-22T12:00:00Z'] })).toBe(
      'calendar',
    );
    expect(
      schedule.inferBroadcastScheduleMode({
        scheduleMode: 'legacy',
        scheduledSlots: ['2026-10-22T12:00:00Z'],
      }),
    ).toBe('legacy');
  });

  it('shares button validators and constants without replacing permissive stored drafts', () => {
    for (const facade of [core, root, broadcast, fields])
      expect(facade.broadcastLinkButtonSchema).toBe(buttons.broadcastLinkButtonSchema);
    expect(fields.storedLinkButtonDraftSchema).toBe(buttons.storedLinkButtonDraftSchema);
    expect(buttons.broadcastLinkButtonSchema.shape.text).toBe(message.botButtonTextSchema);
    expect(buttons.broadcastLinkButtonSchema.shape.url).toBe(message.botButtonUrlSchema);
    expect(buttons.storedLinkButtonDraftSchema.shape.text).toBe(message.botButtonTextSchema);
    expect(buttons.storedLinkButtonDraftSchema.shape.url).toBe(message.botButtonUrlSchema);
    expect(buttons.DEFAULT_BROADCAST_BUTTON_TEXT).toBe(common.DEFAULT_BROADCAST_BUTTON_TEXT);
    expect(buttons.MAX_BROADCAST_LINK_BUTTONS).toBe(common.MAX_BROADCAST_LINK_BUTTONS);
    expect(buttons.MAX_BROADCAST_LINK_BUTTONS_PER_ROW).toBe(
      common.MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
    );
    expect(buttons.storedLinkButtonDraftSchema.parse({ text: ' ', url: '' })).toEqual({
      text: '',
      url: '',
    });
    expect(buttons.broadcastLinkButtonSchema.safeParse({ text: ' ', url: '' }).success).toBe(false);
    expect(
      buttons.broadcastLinkButtonSchema.safeParse({
        text: 'Открыть',
        url: 'https://max.ru/bot?start=pmh-private',
      }).success,
    ).toBe(false);
  });
});
