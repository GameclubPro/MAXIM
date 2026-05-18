import type { ChatSettings } from '@maxim/contracts';

export type ApplySectionKey =
  | 'links'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'thematicFilters'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'requiredSubscription'
  | 'invitationAccess'
  | 'extra';

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
  thematicFilters: [
    'thematicCodewordEnabled',
    'thematicCodeword',
    'thematicFiltersBotMessageEnabled',
    'thematicFiltersWarnEnabled',
    'thematicFiltersMuteEnabled',
    'thematicFiltersMuteDurationHours',
    'thematicFiltersBanEnabled',
    'thematicFiltersBotButtons',
    'thematicFiltersBotButtonEnabled',
    'thematicFiltersBotButtonUrl',
    'thematicFiltersBotButtonText',
    'thematicFiltersAdminContactButtonEnabled',
    'thematicFiltersAdminContactButtonUrl',
  ],
  duplicates: [
    'antiDuplicateEnabled',
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
    'phoneNumbersEnabled',
    'messageLimitsBlockedWords',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtons',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'messageLimitsAdminContactButtonEnabled',
    'messageLimitsAdminContactButtonUrl',
  ],
  night: [...NIGHT_SECTION_SETTING_KEYS],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionDurationDays',
    'requiredSubscriptionExpiresAt',
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
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
  extra: [
    'deleteSpammersEnabled',
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
};

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
