import { BadRequestException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  channelPostSignatureSettingsSchema,
  channelSettingsSchema,
  chatSettingsSchema,
  stopWordsPolicySchema,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  type ChatSettings,
} from '@maxim/contracts';
import type {
  NetworkSettingsChange,
  NetworkSettingsField,
  NetworkSettingsSection,
} from '@maxim/contracts/network-settings';
import {
  CHAT_SETTINGS_BUTTON_GROUPS,
  SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS,
  SETTINGS_SECTION_KEYS,
} from './admin.service.support';

const DERIVED_CHAT_PATHS = new Set<string>([
  'requiredSubscriptionEnabled',
  'requiredSubscriptionBotMessageEnabled',
  'nightModeForceCloseUntil',
  ...CHAT_SETTINGS_BUTTON_GROUPS.flatMap((group) => [group.url, group.text]),
]);

const CHANNEL_SECTIONS = {
  quickButtons: ['quickButtonsEnabled'],
  comments: [
    'commentsEnabled',
    'commentsModerationEnabled',
    'commentsBlockLinksEnabled',
    'commentsAntiSpamEnabled',
    'commentsLimitTwoInRowEnabled',
    'commentsMessageText',
  ],
  postSignature: ['enabled', 'presentation', 'text', 'url'],
} as const;
const STOP_WORD_PATHS = [
  'enabled',
  'rules',
  'domains',
  'imageScanEnabled',
  'sanctions.botMessageEnabled',
  'sanctions.botMessageText',
  'sanctions.warnEnabled',
  'sanctions.warnMessageText',
  'sanctions.muteEnabled',
  'sanctions.muteDurationHours',
  'sanctions.banEnabled',
  'sanctions.botButtonEnabled',
  'sanctions.botButtons',
  'sanctions.adminContactButtonEnabled',
  'sanctions.adminContactButtonUrl',
  'sanctions.rulesButtonEnabled',
  'sanctions.media.explanation',
  'sanctions.media.warning',
];

export function networkSettingsPaths(
  entityType: 'chat' | 'channel',
  section: NetworkSettingsSection,
): string[] {
  if (entityType === 'channel') {
    if (!Object.hasOwn(CHANNEL_SECTIONS, section))
      throw new BadRequestException('Раздел недоступен для каналов.');
    return [...CHANNEL_SECTIONS[section as keyof typeof CHANNEL_SECTIONS]];
  }
  if (!Object.hasOwn(SETTINGS_SECTION_KEYS, section))
    throw new BadRequestException('Раздел недоступен для чатов.');
  if (section === 'stopWords') return STOP_WORD_PATHS.map((path) => `stopWordsPolicy.${path}`);
  const chatSection = section as keyof typeof SETTINGS_SECTION_KEYS;
  return [
    ...SETTINGS_SECTION_KEYS[chatSection].filter((key) => !DERIVED_CHAT_PATHS.has(key)),
    ...SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[chatSection].map((key) => `botSpeechMedia.${key}`),
  ];
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === 'object'
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

export function commonNetworkSettingsFields(
  paths: readonly string[],
  snapshots: readonly unknown[],
): Record<string, NetworkSettingsField> {
  return Object.fromEntries(
    paths.map((path) => {
      const first = getPath(snapshots[0], path) ?? null;
      return [
        path,
        snapshots.every((snapshot) => isDeepStrictEqual(getPath(snapshot, path) ?? null, first))
          ? { kind: 'common', value: first }
          : { kind: 'mixed' },
      ];
    }),
  );
}

export function buildNetworkSettingsPatch<T extends object>(
  current: T,
  entityType: 'chat' | 'channel',
  section: NetworkSettingsSection,
  changes: readonly NetworkSettingsChange[],
): T {
  const allowed = new Set(networkSettingsPaths(entityType, section));
  const next = structuredClone(current) as Record<string, unknown>;
  for (const change of changes) {
    if (!allowed.has(change.path))
      throw new BadRequestException('Изменения содержат поля другого раздела.');
    const keys = change.path.split('.');
    // FLAG: Paths are an explicit section allowlist; never permit prototype traversal or
    // whole-object replacements to smuggle defaults into untouched fields.
    let parent = next;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key]))
        parent[key] = {};
      parent = parent[key] as Record<string, unknown>;
    }
    const key = keys.at(-1)!;
    const optionalMedia =
      change.path.startsWith('botSpeechMedia.') || change.path.includes('.media.');
    if (change.op === 'clear') {
      if (!optionalMedia)
        throw new BadRequestException('Удалять можно только выбранное изображение.');
      delete parent[key];
    } else {
      const existing = getPath(current, change.path);
      if ((Array.isArray(existing) || Array.isArray(change.value)) && change.op !== 'replace')
        throw new BadRequestException('Для списка требуется явная замена.');
      if (change.op === 'replace' && !Array.isArray(existing))
        throw new BadRequestException('Замена списка недоступна для этого поля.');
      if (change.value === undefined) throw new BadRequestException('Значение поля не задано.');
      parent[key] = structuredClone(change.value);
    }
  }
  if (entityType === 'chat') {
    for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
      if (!changes.some((change) => change.path === group.buttons)) continue;
      const primary = (next[group.buttons] as Array<{ url?: unknown; text?: unknown }>)[0];
      // FLAG: An explicitly replaced button array owns its compatibility aliases. Empty arrays
      // must clear the old URL before schema migration can recreate a removed legacy button.
      next[group.url] = primary?.url ?? '';
      next[group.text] = primary?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT;
    }
  }
  const result =
    entityType === 'channel'
      ? (section === 'postSignature'
          ? channelPostSignatureSettingsSchema
          : channelSettingsSchema
        ).safeParse(next)
      : section === 'stopWords'
        ? stopWordsPolicySchema.safeParse(next.stopWordsPolicy)
        : chatSettingsSchema.safeParse(next);
  if (!result.success) throw new BadRequestException(result.error.format());
  return (section === 'stopWords' ? { ...next, stopWordsPolicy: result.data } : result.data) as T;
}

export function networkSettingsAuthoredKeys(
  changes: readonly NetworkSettingsChange[],
): Array<keyof ChatSettings> {
  const keys = new Set(changes.map((change) => change.path.split('.')[0]));
  for (const group of CHAT_SETTINGS_BUTTON_GROUPS)
    if (keys.has(group.buttons)) {
      keys.add(group.url);
      keys.add(group.text);
    }
  if (keys.has('requiredSubscriptionChannelIds')) {
    keys.add('requiredSubscriptionEnabled');
    keys.add('requiredSubscriptionBotMessageEnabled');
    keys.add('requiredSubscriptionExpiresAt');
  }
  return [...keys] as Array<keyof ChatSettings>;
}
