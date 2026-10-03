import {
  formatDeleteBotMessagesDelayLabel,
  type ChatSettings,
  type ChannelSettings,
} from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';
import {
  buildPrivateCallbackButton,
  buildPrivateCallbackPayload,
} from './private-control-callback-buttons';
import { SEARCH_RESULT_LIMIT } from './private-control.constants';
import { compactPrivateText } from './private-control-launcher-renderer';
import {
  formatPrivateControlEnumValue,
  formatPrivateControlSettingValue,
} from './private-control-setting-format';
import { buildPrivateSectionSummaryLines } from './private-control-section-summaries';
import {
  SECTION_ORDER,
  SECTION_FIELDS,
  SECTION_LABELS,
  SECTION_CARD_FIELDS,
  CHANNEL_SECTION_FIELDS,
} from './private-control-settings-schema';
import type {
  PrivateSectionKey,
  PrivateSectionView,
  ChannelSectionKey,
  SettingFieldConfig,
} from './private-control.types';

export function findSettingMatches(query: string): Array<{
  section: PrivateSectionKey;
  key: keyof ChatSettings;
  label: string;
  sectionLabel: string;
}> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const results: Array<{
    section: PrivateSectionKey;
    key: keyof ChatSettings;
    label: string;
    sectionLabel: string;
  }> = [];
  for (const section of SECTION_ORDER) {
    for (const field of SECTION_FIELDS[section]) {
      const fieldKey = String(field.key);
      const aliases = buildFieldAliases(section, fieldKey, field.label);
      if (!aliases.some((item) => item.includes(normalized))) {
        continue;
      }

      results.push({
        section,
        key: field.key,
        label: field.label,
        sectionLabel: SECTION_LABELS[section],
      });
    }
  }

  return results.slice(0, SEARCH_RESULT_LIMIT);
}

export function buildFieldAliases(
  section: PrivateSectionKey,
  key: string,
  label: string,
): string[] {
  const aliasMap: Record<string, string[]> = {
    link: ['ссылка', 'домен', 'allowlist', 'blocklist'],
    greeting: ['приветствие', 'новичок'],
    profanity: ['мат', 'оскорб'],
    commercial: ['реклама', 'коммерция'],
    duplicate: ['дубль', 'повтор'],
    spam: ['спам'],
    night: ['ночной', 'тишина'],
    broadcast: ['автопостинг'],
    button: ['кнопка', 'url'],
    message: ['сообщение', 'текст'],
    ban: ['бан'],
    mute: ['мут', 'мью', 'mute'],
    kick: ['кик'],
    warn: ['предупреждение'],
    timezone: ['часовой пояс', 'timezone'],
  };

  const loweredKey = key.toLowerCase();
  const normalized: string[] = [
    label.toLowerCase(),
    loweredKey,
    SECTION_LABELS[section].toLowerCase(),
    ...loweredKey
      .split(/_|(?=[A-Z])/)
      .map((part) => part.toLowerCase())
      .filter(Boolean),
  ];

  for (const [needle, aliases] of Object.entries(aliasMap)) {
    if (loweredKey.includes(needle)) {
      normalized.push(...aliases.map((value) => value.toLowerCase()));
    }
  }

  return Array.from(new Set(normalized));
}

export function buildSectionFieldConfigs(
  section: PrivateSectionKey,
  view: PrivateSectionView,
): SettingFieldConfig[] {
  const allowed = new Set(SECTION_CARD_FIELDS[section][view]);
  return SECTION_FIELDS[section].filter((field) => allowed.has(field.key));
}

export function buildSectionSummaryLines(
  section: PrivateSectionKey,
  settings: ChatSettings,
  view: PrivateSectionView,
): string[] {
  return buildPrivateSectionSummaryLines(section, settings, view, {
    boolean: (value) => describeBooleanCompact(value),
    linkPolicy: (value) => describeLinkPolicy(value),
  });
}

export function buildSectionActionRows(
  section: PrivateSectionKey,
  settings: ChatSettings,
  view: PrivateSectionView,
): MaxMessageButton[][] {
  const fieldConfigs = buildSectionFieldConfigs(section, view);
  const rows: MaxMessageButton[][] = [];

  for (const field of fieldConfigs) {
    const currentValue = settings[field.key];
    if (field.type === 'boolean') {
      rows.push([
        buildPrivateCallbackButton(
          `${currentValue ? '✅' : '⬜'} ${field.label}`,
          buildPrivateCallbackPayload('toggle', section, String(field.key)),
        ),
      ]);
      continue;
    }

    if (field.type === 'enum') {
      rows.push([
        buildPrivateCallbackButton(
          `🎚 ${field.label}: ${compactPrivateText(formatPrivateControlSettingValue(currentValue, field.type), 20)}`,
          buildPrivateCallbackPayload('noop'),
        ),
      ]);
      rows.push(
        ...(field.enumValues ?? []).map((enumValue) => [
          buildPrivateCallbackButton(
            `${currentValue === enumValue ? '✅' : '◻️'} ${formatPrivateControlEnumValue(enumValue)}`,
            buildPrivateCallbackPayload('set_enum', section, String(field.key), enumValue),
          ),
        ]),
      );
      continue;
    }

    if (field.type === 'number') {
      const numericValue =
        typeof currentValue === 'number' && Number.isFinite(currentValue)
          ? currentValue
          : (field.min ?? 0);
      const step = field.step ?? 1;

      rows.push([
        buildPrivateCallbackButton(
          '➖',
          buildPrivateCallbackPayload('step_number', section, String(field.key), String(-step)),
        ),
        buildPrivateCallbackButton(
          `${field.label}: ${compactPrivateText(formatNumberPreset(field, numericValue), 12)}`,
          buildPrivateCallbackPayload('noop'),
        ),
        buildPrivateCallbackButton(
          '➕',
          buildPrivateCallbackPayload('step_number', section, String(field.key), String(step)),
        ),
      ]);

      if (field.presets?.length) {
        rows.push(
          field.presets
            .slice(0, 3)
            .map((preset) =>
              buildPrivateCallbackButton(
                `${numericValue === preset ? '✅' : '◻️'} ${formatNumberPreset(field, preset)}`,
                buildPrivateCallbackPayload(
                  'set_number_preset',
                  section,
                  String(field.key),
                  String(preset),
                ),
              ),
            ),
        );
      }
      continue;
    }

    if (field.type === 'timezone') {
      rows.push([
        buildPrivateCallbackButton(
          `✏️ ${field.label}`,
          buildPrivateCallbackPayload('set_input', section, String(field.key)),
        ),
      ]);
      continue;
    }

    rows.push([
      buildPrivateCallbackButton(
        `✏️ ${field.label}: ${compactPrivateText(formatPrivateControlSettingValue(currentValue, field.type), 20)}`,
        buildPrivateCallbackPayload('set_input', section, String(field.key)),
      ),
    ]);
  }

  return rows;
}

export function buildChannelSectionSummary(
  section: ChannelSectionKey,
  settings: ChannelSettings,
): string[] {
  if (section === 'post_suggestions') {
    return [
      `Предложка: ${describeBooleanCompact(settings.postSuggestionsEnabled)}`,
      `Режим: ${settings.postSuggestionsEntryMode === 'MINIAPP' ? 'мини-апп' : 'бот'}`,
      `Кнопка: ${describeBooleanCompact(settings.postSuggestionsButtonEnabled)}`,
      `Текст для участников: ${settings.postSuggestionsText.trim() ? 'задан' : 'по умолчанию'}`,
    ];
  }

  return [
    `Комментарии: ${describeBooleanCompact(settings.commentsEnabled)}`,
    `Модерация комментариев: ${describeBooleanCompact(settings.commentsModerationEnabled)}`,
    `Текст-подсказка: ${settings.commentsMessageText.trim() ? 'задан' : 'по умолчанию'}`,
  ];
}

export function buildChannelSectionRows(
  section: ChannelSectionKey,
  settings: ChannelSettings,
): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];
  for (const field of CHANNEL_SECTION_FIELDS[section]) {
    if (field.type === 'boolean') {
      rows.push([
        buildPrivateCallbackButton(
          `${settings[field.key] ? '✅' : '⬜'} ${field.label}`,
          buildPrivateCallbackPayload('toggle_channel', section, String(field.key)),
        ),
      ]);
      continue;
    }

    rows.push([
      buildPrivateCallbackButton(
        `✏️ ${field.label}: ${compactPrivateText(formatPrivateControlSettingValue(settings[field.key], field.type), 18)}`,
        buildPrivateCallbackPayload('set_channel_input', section, String(field.key)),
      ),
    ]);
  }

  return rows;
}

export function describeLinkPolicy(value: ChatSettings['linkPolicy']): string {
  if (value === 'BLOCKLIST_ONLY') {
    return 'удалять все ссылки';
  }
  if (value === 'ALLOWLIST_ONLY') {
    return 'удалять кроме allowlist';
  }
  return 'только предупреждать';
}

export function describeBooleanCompact(value: boolean): string {
  return value ? 'вкл' : 'выкл';
}

export function formatNumberPreset(field: SettingFieldConfig, value: number): string {
  const key = String(field.key).toLowerCase();
  if (key === 'deletebotmessagesdelayminutes' || key === 'greetingdeletebotmessagedelayminutes') {
    return formatDeleteBotMessagesDelayLabel(value);
  }
  if (key.includes('windowsec')) {
    return value % 3600 === 0 ? `${value / 3600}ч` : `${Math.round(value / 60)}м`;
  }
  if (key.includes('durationhours') || key.includes('cooldownhours')) {
    return `${value}ч`;
  }
  if (key.includes('minutes') || key.includes('cooldownminutes')) {
    return `${value}м`;
  }
  if (key.includes('maxlength')) {
    return `${value} симв.`;
  }
  return String(value);
}

export function resolveSectionViewForField(
  section: PrivateSectionKey,
  key: keyof ChatSettings,
): PrivateSectionView {
  return SECTION_CARD_FIELDS[section].advanced.includes(key) ? 'advanced' : 'basic';
}
