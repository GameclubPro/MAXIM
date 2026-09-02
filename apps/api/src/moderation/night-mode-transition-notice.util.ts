import {
  getBotSpeechEditableTemplate,
  type BotSpeechEditableFieldKey,
  type BotSpeechPersona,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { DEFAULT_NIGHT_MODE_TIMEZONE } from './moderation.service.support';

export type NightModeBotSpeechProfile = {
  persona: BotSpeechPersona;
  characterName: string;
};

type NightModeNoticeTextSettings = {
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  templateText: string;
  botSpeechStyle: BotSpeechStyle | null;
  activeBotSpeechProfile: NightModeBotSpeechProfile;
};

export type NightModeNoticeMatchSettings = {
  nightModeEnabled: boolean;
  nightModeBotMessageEnabled: boolean;
  nightModeOpenMessageEnabled: boolean;
  nightModeStartTimeMinutes: number;
  nightModeEndTimeMinutes: number;
  nightModeTimezone: string;
  nightModeBotMessageText: string;
  nightModeOpenMessageText: string;
  botSpeechStyle: BotSpeechStyle | null;
};

export function normalizeNightModeDayMinutes(value: number, fallback: number): number {
  if (Number.isInteger(value) && value >= 0 && value <= 1_439) {
    return value;
  }

  return fallback;
}

export function formatNightModeMinutesAsTime(value: number): string {
  const normalized = normalizeNightModeDayMinutes(value, 0);
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export function buildNightModeClosedNotice(params: NightModeNoticeTextSettings): string {
  const windowLabel = buildNightModeWindowLabel(params.startMinutes, params.endMinutes);
  const timezoneLabel = formatNightModeTimezoneLabel(params.timezone);
  const hasTemplateOverride = hasEditableBotSpeechOverride(params.templateText);

  return renderEditableBotSpeechTemplate({
    style: params.botSpeechStyle,
    fieldKey: 'nightModeBotMessageText',
    overrideText: params.templateText,
    activeBotSpeechProfile: params.activeBotSpeechProfile,
    replacements: {
      user: '',
      night_window: windowLabel,
      night_timezone: timezoneLabel,
      night_status: hasTemplateOverride
        ? 'Новые сообщения временно не принимаются.'
        : 'До открытия новые сообщения будут удаляться.',
    },
  });
}

export function buildNightModeOpenedNotice(params: NightModeNoticeTextSettings): string {
  const windowLabel = buildNightModeWindowLabel(params.startMinutes, params.endMinutes);
  const timezoneLabel = formatNightModeTimezoneLabel(params.timezone);
  const hasTemplateOverride = hasEditableBotSpeechOverride(params.templateText);

  return renderEditableBotSpeechTemplate({
    style: params.botSpeechStyle,
    fieldKey: 'nightModeOpenMessageText',
    overrideText: params.templateText,
    activeBotSpeechProfile: params.activeBotSpeechProfile,
    replacements: {
      user: '',
      night_window: windowLabel,
      night_timezone: timezoneLabel,
      opening_status: hasTemplateOverride ? 'Группа снова открыта.' : 'Чат снова открыт.',
    },
  });
}

export function buildNightModeClosedNoticeForDelivery(
  params: NightModeNoticeTextSettings,
): string {
  const rendered = buildNightModeClosedNotice(params);
  return rendered.trim().length > 0
    ? rendered
    : buildNightModeClosedNotice({ ...params, templateText: '' });
}

export function buildNightModeOpenedNoticeForDelivery(
  params: NightModeNoticeTextSettings,
): string {
  const rendered = buildNightModeOpenedNotice(params);
  return rendered.trim().length > 0
    ? rendered
    : buildNightModeOpenedNotice({ ...params, templateText: '' });
}

export function isNightModeNoticeMessage(params: {
  text: string;
  settings: NightModeNoticeMatchSettings;
  activeBotSpeechProfile: NightModeBotSpeechProfile;
}): boolean {
  if (
    !params.settings.nightModeEnabled ||
    (!params.settings.nightModeBotMessageEnabled && !params.settings.nightModeOpenMessageEnabled)
  ) {
    return false;
  }

  const normalizedMessage = normalizeNightModeNoticeTextForComparison(params.text);
  if (!normalizedMessage) {
    return false;
  }

  if (params.settings.nightModeBotMessageEnabled) {
    const expectedClosedNotice = buildNightModeClosedNoticeForDelivery({
      startMinutes: params.settings.nightModeStartTimeMinutes,
      endMinutes: params.settings.nightModeEndTimeMinutes,
      timezone: params.settings.nightModeTimezone,
      templateText: params.settings.nightModeBotMessageText,
      botSpeechStyle: params.settings.botSpeechStyle,
      activeBotSpeechProfile: params.activeBotSpeechProfile,
    });

    if (normalizedMessage === normalizeNightModeNoticeTextForComparison(expectedClosedNotice)) {
      return true;
    }
  }

  if (params.settings.nightModeOpenMessageEnabled) {
    const expectedOpenNotice = buildNightModeOpenedNoticeForDelivery({
      startMinutes: params.settings.nightModeStartTimeMinutes,
      endMinutes: params.settings.nightModeEndTimeMinutes,
      timezone: params.settings.nightModeTimezone,
      templateText: params.settings.nightModeOpenMessageText,
      botSpeechStyle: params.settings.botSpeechStyle,
      activeBotSpeechProfile: params.activeBotSpeechProfile,
    });

    if (normalizedMessage === normalizeNightModeNoticeTextForComparison(expectedOpenNotice)) {
      return true;
    }
  }

  return false;
}

export function normalizeNightModeNoticeTextForComparison(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function buildNightModeWindowLabel(startMinutes: number, endMinutes: number): string {
  return `${formatNightModeMinutesAsTime(startMinutes)}-${formatNightModeMinutesAsTime(endMinutes)}`;
}

function formatNightModeTimezoneLabel(timezone: string): string {
  return timezone === DEFAULT_NIGHT_MODE_TIMEZONE ? 'Москва' : timezone;
}

function renderEditableBotSpeechTemplate(params: {
  style: BotSpeechStyle | null;
  fieldKey: BotSpeechEditableFieldKey;
  overrideText: string;
  activeBotSpeechProfile: NightModeBotSpeechProfile;
  replacements: Record<string, string>;
}): string {
  const fallback = getBotSpeechEditableTemplate(
    params.style,
    params.fieldKey,
    params.activeBotSpeechProfile.persona,
  );
  const template = resolveEditableBotSpeechText({
    style: params.style,
    fieldKey: params.fieldKey,
    overrideText: params.overrideText,
    activeBotSpeechProfile: params.activeBotSpeechProfile,
  });

  return renderBotMessageTemplate(template, fallback, {
    bot_character_name: params.activeBotSpeechProfile.characterName,
    ...params.replacements,
  });
}

function resolveEditableBotSpeechText(params: {
  style: BotSpeechStyle | null;
  fieldKey: BotSpeechEditableFieldKey;
  overrideText: string;
  activeBotSpeechProfile: NightModeBotSpeechProfile;
}): string {
  // FLAG: Empty means inherited. Never replace a non-empty stored template by matching its text.
  return hasEditableBotSpeechOverride(params.overrideText)
    ? params.overrideText
    : getBotSpeechEditableTemplate(
        params.style,
        params.fieldKey,
        params.activeBotSpeechProfile.persona,
      );
}

function hasEditableBotSpeechOverride(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function renderBotMessageTemplate(
  templateText: string,
  fallbackText: string,
  replacements: Record<string, string>,
): string {
  if (typeof templateText !== 'string' || templateText.length === 0) {
    return fallbackText;
  }

  let rendered = templateText;
  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.split(`{${key}}`).join(value);
  }

  return rendered;
}
