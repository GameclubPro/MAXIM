import type { ChatSettings } from '@maxim/contracts';
import type { BotSpeechMediaFieldKey } from '@maxim/contracts/bot-speech';

export type ApplySectionKey =
  | 'links'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'duplicates'
  | 'limits'
  | 'stopWords'
  | 'phones'
  | 'night'
  | 'requiredSubscription'
  | 'invitationAccess'
  | 'commands'
  | 'storefront'
  | 'extra';

export type SanctionPresetGroup =
  | 'duplicate'
  | 'invitationAccess'
  | 'link'
  | 'messageLimits'
  | 'profanity'
  | 'requiredSubscription'
  | 'textFilters';

type SanctionStageEnabledKey =
  | 'duplicateBotMessageEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateWarnEnabled'
  | 'invitationAccessBotMessageEnabled'
  | 'invitationAccessMuteEnabled'
  | 'invitationAccessWarnEnabled'
  | 'linkBotMessageEnabled'
  | 'linkMuteEnabled'
  | 'linkWarnEnabled'
  | 'messageLimitsBotMessageEnabled'
  | 'messageLimitsMuteEnabled'
  | 'messageLimitsWarnEnabled'
  | 'profanityBotMessageEnabled'
  | 'profanityMuteEnabled'
  | 'profanityWarnEnabled'
  | 'requiredSubscriptionBotMessageEnabled'
  | 'requiredSubscriptionMuteEnabled'
  | 'requiredSubscriptionWarnEnabled'
  | 'textFiltersBotMessageEnabled'
  | 'textFiltersMuteEnabled'
  | 'textFiltersWarnEnabled';

const DEFAULT_SANCTION_STAGE_KEYS: Record<
  SanctionPresetGroup,
  readonly [SanctionStageEnabledKey, SanctionStageEnabledKey, SanctionStageEnabledKey]
> = {
  duplicate: ['duplicateBotMessageEnabled', 'duplicateWarnEnabled', 'duplicateMuteEnabled'],
  invitationAccess: [
    'invitationAccessBotMessageEnabled',
    'invitationAccessWarnEnabled',
    'invitationAccessMuteEnabled',
  ],
  link: ['linkBotMessageEnabled', 'linkWarnEnabled', 'linkMuteEnabled'],
  messageLimits: [
    'messageLimitsBotMessageEnabled',
    'messageLimitsWarnEnabled',
    'messageLimitsMuteEnabled',
  ],
  profanity: ['profanityBotMessageEnabled', 'profanityWarnEnabled', 'profanityMuteEnabled'],
  requiredSubscription: [
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionMuteEnabled',
  ],
  textFilters: ['textFiltersBotMessageEnabled', 'textFiltersWarnEnabled', 'textFiltersMuteEnabled'],
};

export function applyDefaultSanctionStages(
  settings: ChatSettings,
  group: SanctionPresetGroup,
): ChatSettings {
  const nextSettings = { ...settings };
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;

  for (const key of DEFAULT_SANCTION_STAGE_KEYS[group]) {
    nextRecord[key] = true;
  }

  return nextSettings;
}

export function enableDefaultSanctionStages(
  setFieldValue: (key: SanctionStageEnabledKey, value: true) => void,
  group: SanctionPresetGroup,
): void {
  for (const key of DEFAULT_SANCTION_STAGE_KEYS[group]) {
    setFieldValue(key, true);
  }
}

export function applyRequiredSubscriptionChannelAddition(
  settings: ChatSettings,
  channelId: string,
  maxChannels: number,
): ChatSettings {
  if (
    settings.requiredSubscriptionChannelIds.includes(channelId) ||
    settings.requiredSubscriptionChannelIds.length >= maxChannels
  ) {
    return settings;
  }

  const nextSettings =
    settings.requiredSubscriptionChannelIds.length === 0
      ? applyDefaultSanctionStages(settings, 'requiredSubscription')
      : settings;
  return {
    ...nextSettings,
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [...settings.requiredSubscriptionChannelIds, channelId],
    requiredSubscriptionExpiresAt: '',
  };
}

export function normalizeRequiredSubscriptionDraftSettings(settings: ChatSettings): ChatSettings {
  const requiredSubscriptionChannelIds = Array.from(
    new Set(
      settings.requiredSubscriptionChannelIds
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );

  return {
    ...settings,
    requiredSubscriptionEnabled: requiredSubscriptionChannelIds.length > 0,
    requiredSubscriptionChannelIds,
    requiredSubscriptionBotMessageEnabled: requiredSubscriptionChannelIds.length > 0,
    requiredSubscriptionExpiresAt: '',
  };
}

export const BOT_SPEECH_SYNC_SETTING_KEYS = ['botSpeechStyle'] as const satisfies ReadonlyArray<
  keyof ChatSettings
>;

export const NIGHT_SECTION_SETTING_KEYS = [
  'nightModeEnabled',
  'nightModeStartTimeMinutes',
  'nightModeEndTimeMinutes',
  'nightModeTimezone',
  'nightModeBotMessageEnabled',
  'nightModeBotMessageText',
  'nightModeCommentsEnabled',
  'nightModeOpenMessageEnabled',
  'nightModeOpenMessageText',
  'nightModeBotButtons',
  'nightModeBotButtonEnabled',
  'nightModeBotButtonUrl',
  'nightModeBotButtonText',
  'nightModeRulesButtonEnabled',
  'nightModeForceCloseEnabled',
  'nightModeForceCloseForever',
  'nightModeForceCloseHours',
  'nightModeForceCloseDays',
  'nightModeForceCloseUntil',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export const SECTION_SETTING_KEYS: Record<ApplySectionKey, readonly (keyof ChatSettings)[]> = {
  links: [
    'linkPolicy',
    'linkEscalationWindowHours',
    'linkWarnMaxCount',
    'linkMuteMaxCount',
    'linkBanMaxCount',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkMuteEnabled',
    'linkMuteDurationHours',
    'linkBanEnabled',
    'linkBotButtons',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
    'linkAdminContactButtonEnabled',
    'linkAdminContactButtonUrl',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingDeleteBotMessageEnabled',
    'greetingDeleteBotMessageDelayMinutes',
    'greetingBotMessageText',
    'greetingBotButtons',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
    'greetingRulesButtonEnabled',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanitySensitivity',
    'profanityBotMessageEnabled',
    'profanityWarnEnabled',
    'profanityMuteEnabled',
    'profanityMuteDurationHours',
    'profanityBanEnabled',
    'profanityAdminContactButtonEnabled',
    'profanityAdminContactButtonUrl',
  ],
  commercialFilter: [
    'commercialAdsFilterEnabled',
    'commercialAdsSensitivity',
    'commercialAdsWarnThreshold',
    'commercialAdsDeleteThreshold',
    'textFiltersBotMessageEnabled',
    'textFiltersBotMessageText',
    'textFiltersWarnEnabled',
    'textFiltersWarnMessageText',
    'textFiltersMuteEnabled',
    'textFiltersMuteDurationHours',
    'textFiltersBanEnabled',
    'textFiltersBotButtons',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
    'textFiltersAdminContactButtonEnabled',
    'textFiltersAdminContactButtonUrl',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateDetectionPreset',
    'duplicatePhotoEnabled',
    'duplicatePhotoMatchPreset',
    'duplicatePhotoScope',
    'duplicateIgnoreLinksEnabled',
    'duplicateIgnorePhonesEnabled',
    'duplicateNearMatchEnabled',
    'duplicateWarnEnabled',
    'duplicateMuteEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateMuteWindowSec',
    'duplicateMuteMaxCount',
    'duplicateMuteDurationHours',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtons',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
    'duplicateAdminContactButtonEnabled',
    'duplicateAdminContactButtonUrl',
  ],
  limits: [
    'antiSpamEnabled',
    'deleteSpammersEnabled',
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'photoMessagesEnabled',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'forwardedMessagesEnabled',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsWarnMessageText',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtons',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'messageLimitsAdminContactButtonEnabled',
    'messageLimitsAdminContactButtonUrl',
    'phoneNumbersEnabled',
  ],
  stopWords: [
    'messageLimitsBlockedWords',
    'messageLimitsBlockedDomains',
    'messageLimitsBotMessageText',
    'messageLimitsWarnMessageText',
  ],
  phones: [
    'phoneNumbersEnabled',
    'phoneNumbersBotMessageEnabled',
    'phoneNumbersBotMessageText',
    'phoneNumbersWarnEnabled',
    'phoneNumbersMuteEnabled',
    'phoneNumbersMuteDurationHours',
    'phoneNumbersBanEnabled',
    'phoneNumbersEscalationWindowHours',
    'phoneNumbersWarnMaxCount',
    'phoneNumbersMuteMaxCount',
    'phoneNumbersBanMaxCount',
    'phoneNumbersAdminContactButtonEnabled',
    'phoneNumbersAdminContactButtonUrl',
  ],
  night: [...NIGHT_SECTION_SETTING_KEYS],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionButtonText',
    'requiredSubscriptionAdminContactButtonEnabled',
    'requiredSubscriptionAdminContactButtonUrl',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionWarnMessageText',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionMuteDurationHours',
    'requiredSubscriptionBanEnabled',
  ],
  invitationAccess: [
    'invitationAccessEnabled',
    'invitationAccessRequiredCount',
    'invitationAccessBotMessageEnabled',
    'invitationAccessBotMessageText',
    'invitationAccessAdminContactButtonEnabled',
    'invitationAccessAdminContactButtonUrl',
    'invitationAccessWarnEnabled',
    'invitationAccessWarnMessageText',
    'invitationAccessMuteEnabled',
    'invitationAccessMuteDurationHours',
    'invitationAccessBanEnabled',
  ],
  commands: [
    'adminBanCommandName',
    'adminBanAllCommandName',
    'adminMuteCommandName',
    'adminPermanentMuteCommandName',
    'adminRulesCommandName',
    'adminSilenceCommandName',
    'adminOpenChatCommandName',
  ],
  storefront: ['karavanStorefrontEnabled', 'karavanStorefrontAdminsOnly'],
  extra: [
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
};

export function mergeBotSpeechMediaForKeys(
  targetMedia: ChatSettings['botSpeechMedia'],
  sourceMedia: ChatSettings['botSpeechMedia'],
  settingKeys: readonly (keyof ChatSettings)[],
): ChatSettings['botSpeechMedia'] {
  const nextMedia = { ...targetMedia };
  for (const key of settingKeys) {
    const mediaKey = key as BotSpeechMediaFieldKey;
    const sourceImage = sourceMedia[mediaKey];
    if (sourceImage?.base64) {
      nextMedia[mediaKey] = sourceImage;
    } else {
      delete nextMedia[mediaKey];
    }
  }
  return nextMedia;
}

function areBotSpeechMediaImagesEqual(
  left: ChatSettings['botSpeechMedia'][BotSpeechMediaFieldKey] | undefined,
  right: ChatSettings['botSpeechMedia'][BotSpeechMediaFieldKey] | undefined,
): boolean {
  return (
    (left?.base64 ?? '') === (right?.base64 ?? '') &&
    (left?.mimeType ?? '') === (right?.mimeType ?? '') &&
    (left?.fileName ?? '') === (right?.fileName ?? '')
  );
}

export function hasSectionBotSpeechMediaChanges(
  draft: ChatSettings,
  saved: ChatSettings,
  section: ApplySectionKey,
): boolean {
  return SECTION_SETTING_KEYS[section].some((key) => {
    const mediaKey = key as BotSpeechMediaFieldKey;
    return !areBotSpeechMediaImagesEqual(
      draft.botSpeechMedia[mediaKey],
      saved.botSpeechMedia[mediaKey],
    );
  });
}

export const COMMENTS_SETTING_KEYS = [
  'commentsEnabled',
  'commentsAdminsEnabled',
  'commentsChatBroadcastsEnabled',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export function applyNightModeEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeEnabled: false,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function applyNightModeBotMessageEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function mergeNightSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of NIGHT_SECTION_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }
  nextSettings.botSpeechMedia = mergeBotSpeechMediaForKeys(
    targetSettings.botSpeechMedia,
    sourceSettings.botSpeechMedia,
    NIGHT_SECTION_SETTING_KEYS,
  );

  return nextSettings;
}

export function mergeSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
  section: ApplySectionKey,
): ChatSettings {
  if (section === 'night') {
    return mergeNightSectionSettings(targetSettings, sourceSettings);
  }

  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of SECTION_SETTING_KEYS[section]) {
    nextRecord[key] = sourceRecord[key];
  }
  nextSettings.botSpeechMedia = mergeBotSpeechMediaForKeys(
    targetSettings.botSpeechMedia,
    sourceSettings.botSpeechMedia,
    SECTION_SETTING_KEYS[section],
  );

  return nextSettings;
}

export function mergeCommentsSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of COMMENTS_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }

  nextSettings.commentsAllEnabled = false;

  return nextSettings;
}

export function mergeBotSpeechStyleSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  return {
    ...targetSettings,
    botSpeechStyle: sourceSettings.botSpeechStyle,
  };
}
