import type { NetworkSettingsChange } from '@maxim/contracts/network-settings';
import {
  buildDuplicateFlowThresholds,
  resolveDuplicateFlowAllowedCount,
  resolveDuplicateFlowAllowedCountMax,
  resolveCommercialSliderProfile,
  type ChatSettings,
  type DuplicateFlowStageSettings,
  type DuplicateFlowThresholdSettings,
} from '@maxim/contracts/settings';
import type { ChatSettingsFieldAdapter, ChatSettingsFieldValues } from './field-model';

export type ChatFieldOfType<T> = {
  [K in keyof ChatSettingsFieldValues]-?: ChatSettingsFieldValues[K] extends T ? K : never;
}[keyof ChatSettingsFieldValues] &
  string;
export type ChatBooleanField = ChatFieldOfType<boolean>;
export type ChatNumberField = ChatFieldOfType<number>;
export type ChatStringField = ChatFieldOfType<string>;

const set = (path: string, value: unknown): NetworkSettingsChange => ({ op: 'set', path, value });
const sanctionGroups = {
  russianProfanityFilterEnabled: 'profanity',
  commercialAdsFilterEnabled: 'textFilters',
} as const;

// FLAG: Every dependent value below is part of the user's one explicit action.
export function setChatBoolean(
  fields: ChatSettingsFieldAdapter,
  path: ChatBooleanField,
  enabled: boolean,
) {
  const changes: NetworkSettingsChange[] = [set(path, enabled)];
  if (enabled && Object.hasOwn(sanctionGroups, path)) {
    const prefix = sanctionGroups[path as keyof typeof sanctionGroups];
    changes.push(
      ...['BotMessageEnabled', 'WarnEnabled', 'MuteEnabled'].map((suffix) =>
        set(prefix + suffix, true),
      ),
    );
  }
  if (path === 'greetingEnabled') {
    changes.push(set('greetingBotMessageEnabled', enabled));
    if (!enabled)
      changes.push(
        set('greetingBotButtonEnabled', false),
        set('greetingRulesButtonEnabled', false),
      );
  }
  if (path === 'nightModeEnabled') {
    changes.push(set('nightModeBotMessageEnabled', enabled));
    if (!enabled)
      changes.push(
        ...[
          'nightModeCommentsEnabled',
          'nightModeBotButtonEnabled',
          'nightModeRulesButtonEnabled',
        ].map((key) => set(key, false)),
      );
  }
  if (path === 'nightModeBotMessageEnabled' && !enabled)
    changes.push(
      ...[
        'nightModeCommentsEnabled',
        'nightModeBotButtonEnabled',
        'nightModeRulesButtonEnabled',
      ].map((key) => set(key, false)),
    );
  if (path === 'greetingBotMessageEnabled' && !enabled)
    changes.push(set('greetingBotButtonEnabled', false), set('greetingRulesButtonEnabled', false));
  const buttonGroup = /^(link|textFilters|messageLimits)BotMessageEnabled$/.exec(path);
  if (buttonGroup && !enabled) changes.push(set(buttonGroup[1] + 'BotButtonEnabled', false));
  const limitActivation = [
    'slowModeEnabled',
    'mediaMessageCooldownEnabled',
    'antiSpamEnabled',
    'messageCountLimitEnabled',
    'maxMessageLengthEnabled',
    'photoMessageCooldownEnabled',
    'stickerMessageCooldownEnabled',
  ];
  const rejectedType = [
    'photoMessagesEnabled',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'forwardedMessagesEnabled',
  ];
  if ((enabled && limitActivation.includes(path)) || (!enabled && rejectedType.includes(path)))
    changes.push(
      ...[
        'messageLimitsBotMessageEnabled',
        'messageLimitsWarnEnabled',
        'messageLimitsMuteEnabled',
      ].map((key) => set(key, true)),
    );
  const stage =
    /^(link|profanity|textFilters|messageLimits|phoneNumbers|invitationAccess|requiredSubscription)(Warn|Mute|Ban)Enabled$/.exec(
      path,
    );
  if (enabled && stage) {
    const prefix = stage[1];
    // FLAG: Subscription explanations are mandatory and derived from the selected list.
    if (prefix !== 'requiredSubscription') changes.push(set(prefix + 'BotMessageEnabled', true));
    if (stage[2] !== 'Warn') changes.push(set(prefix + 'WarnEnabled', true));
  }
  if (enabled && /^stopWordsPolicy\.sanctions\.(warn|mute|ban)Enabled$/.test(path)) {
    changes.push(set('stopWordsPolicy.sanctions.botMessageEnabled', true));
    if (!path.endsWith('.warnEnabled'))
      changes.push(set('stopWordsPolicy.sanctions.warnEnabled', true));
  }
  if (/^duplicate(BotMessage|Warn|Mute|Ban)Enabled$/.test(path)) {
    const flow = readCommonDuplicateFlow(fields);
    if (flow)
      changes.push(
        ...Object.entries(
          buildDuplicateFlowThresholds({
            ...flow,
            [path]: enabled,
            allowedCount: resolveDuplicateFlowAllowedCount(flow),
          }),
        ).map(([key, value]) => set(key, value)),
      );
  }
  fields.transact([...new Map(changes.map((change) => [change.path, change])).values()]);
}

const duplicateFlowPaths = [
  'duplicateBotMessageEnabled',
  'duplicateWarnEnabled',
  'duplicateMuteEnabled',
  'duplicateBanEnabled',
  'duplicateWarnMaxCount',
  'duplicateMuteMaxCount',
  'duplicateBanMaxCount',
] as const;
export function readCommonDuplicateFlow(
  fields: ChatSettingsFieldAdapter,
): (DuplicateFlowStageSettings & DuplicateFlowThresholdSettings) | null {
  const entries: [string, boolean | number][] = [];
  for (const path of duplicateFlowPaths) {
    const state = fields.read(path);
    if (state.kind !== 'common') return null;
    entries.push([path, state.value]);
  }
  return Object.fromEntries(entries) as DuplicateFlowStageSettings & DuplicateFlowThresholdSettings;
}

export function setChatDuplicateAllowedCount(
  fields: ChatSettingsFieldAdapter,
  allowedCount: number,
) {
  const flow = readCommonDuplicateFlow(fields);
  if (!flow) return;
  if (
    !Number.isInteger(allowedCount) ||
    allowedCount < 0 ||
    allowedCount > resolveDuplicateFlowAllowedCountMax(flow)
  ) {
    fields.setError('duplicateWarnMaxCount', 'Укажите допустимое число повторов.');
    return;
  }
  fields.transact(
    Object.entries(buildDuplicateFlowThresholds({ ...flow, allowedCount })).map(([path, value]) =>
      set(path, value),
    ),
  );
}

export function setChatDuplicateWindowHours(fields: ChatSettingsFieldAdapter, hours: number) {
  fields.transact(
    ['duplicateWarnWindowSec', 'duplicateMuteWindowSec', 'duplicateBanWindowSec'].map((path) =>
      set(path, hours * 3600),
    ),
  );
}

export function setChatLinkPolicy(
  fields: ChatSettingsFieldAdapter,
  value: ChatSettings['linkPolicy'],
) {
  const previous = fields.read('linkPolicy');
  fields.transact([
    set('linkPolicy', value),
    ...(previous.kind === 'common' && previous.value === 'ALERT_ONLY' && value !== 'ALERT_ONLY'
      ? ['linkBotMessageEnabled', 'linkWarnEnabled', 'linkMuteEnabled'].map((path) =>
          set(path, true),
        )
      : []),
  ]);
}

export function setChatDuplicatePreset(
  fields: ChatSettingsFieldAdapter,
  value: ChatSettings['duplicateDetectionPreset'],
) {
  fields.transact([
    set('duplicateDetectionPreset', value),
    ...(value === 'CUSTOM'
      ? []
      : [
          'duplicateIgnoreLinksEnabled',
          'duplicateIgnorePhonesEnabled',
          'duplicateNearMatchEnabled',
        ].map((path) => set(path, value === 'STRICT'))),
  ]);
}

export function setChatCommercialSensitivity(fields: ChatSettingsFieldAdapter, position: number) {
  fields.transact(
    Object.entries(resolveCommercialSliderProfile(position)).map(([path, value]) =>
      set(path, value),
    ),
  );
}
