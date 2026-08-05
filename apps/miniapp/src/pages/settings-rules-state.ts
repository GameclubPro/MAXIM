import type { ChatRules, ChatSettings, ChatSettingsScreenResponse } from '@maxim/contracts';
import type { UpdateChatRulesPayload } from '../lib/api/shared-types';

type RulesDraftSerializable = Pick<
  ChatRules,
  | 'text'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'autoTextEnabled'
  | 'buttons'
  | 'buttonEnabled'
  | 'buttonUrl'
  | 'buttonText'
  | 'adminContactButtonEnabled'
  | 'adminContactButtonUrl'
> &
  Pick<
    UpdateChatRulesPayload,
    | 'text'
    | 'imageBase64'
    | 'imageMimeType'
    | 'imageFileName'
    | 'autoTextEnabled'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  >;

type RulesTextScreenState = Pick<
  ChatSettingsScreenResponse,
  'settings' | 'duplicatePhotoModerationMode' | 'domains' | 'requiredSubscriptionChannels'
>;

function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<ChatSettings, 'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds'>,
): boolean {
  return settings.requiredSubscriptionEnabled && settings.requiredSubscriptionChannelIds.length > 0;
}

export function serializeRulesDraftPayload(value: RulesDraftSerializable): string {
  return JSON.stringify({
    text: value.text,
    imageBase64: value.imageBase64,
    imageMimeType: value.imageMimeType,
    imageFileName: value.imageFileName,
    autoTextEnabled: value.autoTextEnabled,
    buttons: value.buttons,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
    adminContactButtonEnabled: value.adminContactButtonEnabled,
    adminContactButtonUrl: value.adminContactButtonUrl,
  });
}

export function shouldHydrateRulesDraftFromServer(params: {
  currentDraft: ChatRules | null;
  previousServerSnapshot: string;
  nextServerDraft: ChatRules;
}): boolean {
  if (!params.currentDraft) {
    return true;
  }

  const currentSnapshot = serializeRulesDraftPayload(params.currentDraft);
  const nextServerSnapshot = serializeRulesDraftPayload(params.nextServerDraft);

  return (
    currentSnapshot === params.previousServerSnapshot || currentSnapshot === nextServerSnapshot
  );
}

export function buildRulesTextFromSettingsScreen(screen: RulesTextScreenState): string {
  const items = buildRulesTextItems(screen);
  if (items.length === 0) {
    throw new Error('Нет активных настроек, из которых можно собрать правила.');
  }

  const lines = ['Правила чата:', ''];
  const numberedItems: string[] = [];

  for (const [index, item] of items.entries()) {
    const numberedItem = `${index + 1}. ${item}`;
    const candidate = [...lines, ...numberedItems, numberedItem].join('\n');
    if (candidate.length > 2_000) {
      break;
    }
    numberedItems.push(numberedItem);
  }

  if (numberedItems.length === 0) {
    throw new Error('Не удалось собрать короткий текст правил из текущих настроек.');
  }

  return [...lines, ...numberedItems].join('\n');
}

function buildRulesTextItems(screen: RulesTextScreenState): string[] {
  const { settings, requiredSubscriptionChannels, domains } = screen;
  const items: string[] = [];

  if (settings.linkPolicy === 'BLOCKLIST_ONLY') {
    items.push('Пожалуйста, не отправляйте ссылки: бот их удаляет.');
  } else if (settings.linkPolicy === 'ALLOWLIST_ONLY') {
    items.push(
      domains.length > 0
        ? 'Можно отправлять только ссылки из разрешённого списка.'
        : 'Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
    );
  } else if (settings.linkPolicy === 'ALERT_ONLY') {
    items.push('Ссылки бот проверяет, но не удаляет автоматически.');
  }

  if (isRequiredSubscriptionCurrentlyActive(settings)) {
    const channelTitles = requiredSubscriptionChannels
      .map((channel) => channel.title.trim())
      .filter(Boolean);
    items.push(
      channelTitles.length > 0
        ? `Чтобы писать в чат, сначала подпишитесь на: ${formatPreviewList(channelTitles, 3)}.`
        : 'Чтобы писать в чат, сначала подпишитесь на обязательные чаты или каналы.',
    );
  }

  if (settings.russianProfanityFilterEnabled) {
    items.push('Пожалуйста, без мата и грубой лексики.');
  }

  if (settings.commercialAdsFilterEnabled) {
    items.push('Коммерческую рекламу публикуйте только по согласованию с администраторами.');
  }

  if (settings.antiDuplicateEnabled) {
    const allowedCount = resolveDuplicateAllowedCount(settings);
    const photoModerationEnforced =
      settings.duplicatePhotoEnabled &&
      (screen.duplicatePhotoModerationMode === 'DELETE_ONLY' ||
        screen.duplicatePhotoModerationMode === 'FULL');
    if (photoModerationEnforced) {
      items.push(
        allowedCount === 0
          ? 'Не отправляйте повторно одинаковые сообщения и фото.'
          : `Не отправляйте повторно одинаковые сообщения и фото: бот среагирует ${formatDuplicateAllowanceLabel(allowedCount)}.`,
      );
    } else {
      items.push(
        allowedCount === 0
          ? 'Не повторяйте одно и то же сообщение несколько раз.'
          : `Не повторяйте одно и то же сообщение: бот среагирует ${formatDuplicateAllowanceLabel(allowedCount)}.`,
      );
    }
  }

  if (settings.antiSpamEnabled) {
    items.push('Пожалуйста, не флудите и не спамьте.');
  }

  if (settings.messageCountLimitEnabled) {
    items.push(
      `Пожалуйста, не отправляйте больше ${settings.messageCountLimitMessages} сообщений за ${settings.messageCountLimitWindowHours} ${formatHoursLabel(settings.messageCountLimitWindowHours)}.`,
    );
  }

  if (settings.maxMessageLengthEnabled) {
    items.push(
      `Старайтесь писать короче: до ${settings.maxMessageLength} символов в одном сообщении.`,
    );
  }

  if (settings.photoMessageCooldownEnabled) {
    items.push(
      `Фото можно отправлять не чаще одного раза в ${settings.photoMessageCooldownHours} ${formatHoursLabel(settings.photoMessageCooldownHours)}.`,
    );
  }

  if (settings.stickerMessageCooldownEnabled) {
    items.push(
      `Стикеры можно отправлять не чаще одного раза в ${settings.stickerMessageCooldownMinutes} ${formatMinutesLabel(settings.stickerMessageCooldownMinutes)}.`,
    );
  }

  if (!settings.photoMessagesEnabled) {
    items.push('Фото сюда отправлять нельзя.');
  }

  if (!settings.videoMessagesEnabled) {
    items.push('Видео сюда отправлять нельзя.');
  }

  if (!settings.fileMessagesEnabled) {
    items.push('Файлы сюда отправлять нельзя.');
  }

  if (!settings.voiceMessagesEnabled) {
    items.push('Голосовые сообщения сюда отправлять нельзя.');
  }

  if (!settings.phoneNumbersEnabled) {
    items.push('Телефонные номера в сообщениях запрещены.');
  }

  if (settings.nightModeEnabled) {
    items.push(
      `Ночью чат работает тише: ограничения действуют с ${formatTime(settings.nightModeStartTimeMinutes)} до ${formatTime(settings.nightModeEndTimeMinutes)}.`,
    );
  }

  const sanctionsSummary = buildRulesSanctionsSummary(
    isRequiredSubscriptionCurrentlyActive(settings)
      ? settings
      : {
          ...settings,
          requiredSubscriptionWarnEnabled: false,
          requiredSubscriptionMuteEnabled: false,
          requiredSubscriptionBanEnabled: false,
        },
  );
  if (sanctionsSummary) {
    items.push(sanctionsSummary);
  }

  return items;
}

function buildRulesSanctionsSummary(
  settings: Pick<
    ChatSettings,
    | 'linkWarnEnabled'
    | 'requiredSubscriptionWarnEnabled'
    | 'textFiltersWarnEnabled'
    | 'messageLimitsWarnEnabled'
    | 'duplicateWarnEnabled'
    | 'linkMuteEnabled'
    | 'requiredSubscriptionMuteEnabled'
    | 'textFiltersMuteEnabled'
    | 'messageLimitsMuteEnabled'
    | 'duplicateMuteEnabled'
    | 'linkBanEnabled'
    | 'requiredSubscriptionBanEnabled'
    | 'textFiltersBanEnabled'
    | 'messageLimitsBanEnabled'
    | 'duplicateBanEnabled'
  >,
): string | null {
  const sanctions = new Set<string>();

  if (
    settings.linkWarnEnabled ||
    settings.requiredSubscriptionWarnEnabled ||
    settings.textFiltersWarnEnabled ||
    settings.messageLimitsWarnEnabled ||
    settings.duplicateWarnEnabled
  ) {
    sanctions.add('предупредить');
  }

  if (
    settings.linkMuteEnabled ||
    settings.requiredSubscriptionMuteEnabled ||
    settings.textFiltersMuteEnabled ||
    settings.messageLimitsMuteEnabled ||
    settings.duplicateMuteEnabled
  ) {
    sanctions.add('временно ограничить сообщения');
  }

  if (
    settings.linkBanEnabled ||
    settings.requiredSubscriptionBanEnabled ||
    settings.textFiltersBanEnabled ||
    settings.messageLimitsBanEnabled ||
    settings.duplicateBanEnabled
  ) {
    sanctions.add('заблокировать');
  }

  if (sanctions.size === 0) {
    return null;
  }

  return `За повторные нарушения бот может ${formatConjunctionList([...sanctions])}.`;
}

function resolveDuplicateAllowedCount(
  settings: Pick<
    ChatSettings,
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateWarnMaxCount'
    | 'duplicateMuteMaxCount'
    | 'duplicateBanMaxCount'
  >,
): number {
  const firstThreshold = settings.duplicateWarnEnabled
    ? settings.duplicateWarnMaxCount
    : settings.duplicateMuteEnabled
      ? settings.duplicateMuteMaxCount
      : settings.duplicateBanEnabled
        ? settings.duplicateBanMaxCount
        : settings.duplicateWarnMaxCount;
  const duplicateThresholdOffset =
    (settings.duplicateBotMessageEnabled ? 2 : 1) +
    (settings.duplicateWarnEnabled ? 1 : 0) +
    (settings.duplicateMuteEnabled ? 1 : 0);
  const allowedCountMax = Math.max(0, 20 - duplicateThresholdOffset);

  return Math.max(
    0,
    Math.min(allowedCountMax, firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1)),
  );
}

function formatDuplicateAllowanceLabel(count: number): string {
  if (count === 0) {
    return 'с первого дубля';
  }

  if (count === 1) {
    return 'после 1 дубля';
  }

  return `после ${count} дублей`;
}

function formatPreviewList(values: readonly string[], limit: number): string {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const visible = uniqueValues.slice(0, limit);
  const remaining = uniqueValues.length - visible.length;
  if (remaining <= 0) {
    return visible.join(', ');
  }

  return `${visible.join(', ')} и ещё ${remaining}`;
}

function formatConjunctionList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  if (values.length === 2) {
    return `${values[0]} и ${values[1]}`;
  }

  return `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;
}

function formatHoursLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'час';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'часа';
  }

  return 'часов';
}

function formatMinutesLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'минуту';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'минуты';
  }

  return 'минут';
}

function formatTime(minutes: number): string {
  const normalized = Math.trunc(minutes);
  const totalMinutes = ((normalized % 1440) + 1440) % 1440;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
