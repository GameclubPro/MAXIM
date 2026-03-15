import type { ChannelDialogType } from '@maxim/contracts';

const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const WORKBENCH_START_PARAM_PREFIX = 'wb-';
const SETTINGS_SECTION_START_PARAM_PREFIX = 'ss-';

type ChannelDialogLaunchPayload = {
  v: 1;
  k: 'channel-dialog';
  c: string;
  m: ChannelDialogType;
  t: string;
};

type GiveawayLaunchPayload = {
  v: 1;
  k: 'giveaway';
  g: string;
};

type WorkbenchLaunchPayload = {
  v: 1;
  k: 'workbench';
  c: string;
  e: 'chat' | 'channel';
  s: string | null;
  screen: string | null;
};

type SettingsSectionLaunchPayload = {
  v: 1;
  k: 'settings-section';
  c: string;
  e: 'chat' | 'channel';
  s: string;
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSearchParam(source: string, names: readonly string[]): string {
  const params = new URLSearchParams(source);
  for (const name of names) {
    const candidate = params.get(name);
    if (candidate?.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function readStartParamFromLocation(): string {
  const names = ['WebAppStartParam', 'startapp', 'startApp', 'start_param', 'startParam'];
  return (
    readSearchParam(window.location.search, names) ||
    readSearchParam(window.location.hash.replace(/^#/, ''), names)
  );
}

function readStartParamFromBridge(): string {
  const candidates = [
    window.WebApp?.initDataUnsafe?.start_param,
    window.WebApp?.init_data_unsafe?.start_param,
    window.WebApp?.startParam,
    window.WebApp?.start_param,
    window.MAX?.WebApp?.initDataUnsafe?.start_param,
    window.MAX?.WebApp?.init_data_unsafe?.start_param,
    window.MAX?.WebApp?.startParam,
    window.MAX?.WebApp?.start_param,
  ];

  for (const candidate of candidates) {
    const normalized = readString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function readStartParamFromInitData(initData: string): string {
  if (!initData.trim()) {
    return '';
  }

  return readSearchParam(initData, ['start_param', 'startParam', 'WebAppStartParam']);
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = window.atob(`${normalized}${padding}`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseChannelDialogStartParam(value: string): ChannelDialogLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(CHANNEL_DIALOG_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(CHANNEL_DIALOG_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<ChannelDialogLaunchPayload>;
    const chatId = readString(parsed.c);
    const type = parsed.m === 'suggest' ? 'suggest' : parsed.m === 'comments' ? 'comments' : null;
    const token = readString(parsed.t);
    if (
      parsed.v !== 1 ||
      parsed.k !== 'channel-dialog' ||
      !chatId ||
      !type ||
      token.length < 16 ||
      token.length > 256
    ) {
      return null;
    }

    return {
      v: 1,
      k: 'channel-dialog',
      c: chatId,
      m: type,
      t: token,
    };
  } catch {
    return null;
  }
}

function parseGiveawayStartParam(value: string): GiveawayLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(GIVEAWAY_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(GIVEAWAY_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<GiveawayLaunchPayload>;
    const giveawayId = readString(parsed.g);
    if (parsed.v !== 1 || parsed.k !== 'giveaway' || !giveawayId) {
      return null;
    }

    return {
      v: 1,
      k: 'giveaway',
      g: giveawayId,
    };
  } catch {
    return null;
  }
}

function parseWorkbenchStartParam(value: string): WorkbenchLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(WORKBENCH_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(WORKBENCH_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<WorkbenchLaunchPayload>;
    const chatId = readString(parsed.c);
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    if (parsed.v !== 1 || parsed.k !== 'workbench' || !chatId || !entityType) {
      return null;
    }

    return {
      v: 1,
      k: 'workbench',
      c: chatId,
      e: entityType,
      s: readString(parsed.s) || null,
      screen: readString(parsed.screen) || null,
    };
  } catch {
    return null;
  }
}

function parseSettingsSectionStartParam(value: string): SettingsSectionLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(SETTINGS_SECTION_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(SETTINGS_SECTION_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<SettingsSectionLaunchPayload>;
    const chatId = readString(parsed.c);
    const entityType = parsed.e === 'channel' ? 'channel' : parsed.e === 'chat' ? 'chat' : null;
    const section = readString(parsed.s);
    if (parsed.v !== 1 || parsed.k !== 'settings-section' || !chatId || !entityType || !section) {
      return null;
    }

    return {
      v: 1,
      k: 'settings-section',
      c: chatId,
      e: entityType,
      s: section,
    };
  } catch {
    return null;
  }
}

export function resolveLaunchRoute(initData: string): string | null {
  const startParam =
    readStartParamFromLocation() ||
    readStartParamFromBridge() ||
    readStartParamFromInitData(initData);

  const settingsSectionLaunch = parseSettingsSectionStartParam(startParam);
  if (settingsSectionLaunch) {
    return `/${settingsSectionLaunch.e}/${encodeURIComponent(
      settingsSectionLaunch.c,
    )}/settings?section=${encodeURIComponent(settingsSectionLaunch.s)}`;
  }

  const workbenchLaunch = parseWorkbenchStartParam(startParam);
  if (workbenchLaunch) {
    return `/${workbenchLaunch.e}/${encodeURIComponent(workbenchLaunch.c)}`;
  }

  const giveawayLaunch = parseGiveawayStartParam(startParam);
  if (giveawayLaunch) {
    return `/giveaways/${encodeURIComponent(giveawayLaunch.g)}`;
  }

  const channelDialogLaunch = parseChannelDialogStartParam(startParam);
  if (!channelDialogLaunch) {
    return null;
  }

  return `/channel/${encodeURIComponent(channelDialogLaunch.c)}/dialog/${channelDialogLaunch.m}?token=${encodeURIComponent(channelDialogLaunch.t)}`;
}

export const resolveLaunchDialogRoute = resolveLaunchRoute;
