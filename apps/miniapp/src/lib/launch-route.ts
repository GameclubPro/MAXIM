import type { ChannelDialogType } from '@maxim/contracts';

const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';

const CHAT_SETTINGS_FOCUS = new Set([
  'broadcast',
  'comments',
  'giveaway',
  'requiredSubscription',
  'rules',
  'vkParsing',
]);
const CHANNEL_SETTINGS_FOCUS = new Set([
  'broadcast',
  'comments',
  'giveaway',
  'postSuggestions',
  'vkParsing',
]);

type ChannelDialogLaunchPayload = {
  v: 1;
  k: 'channel-dialog' | 'chat-dialog';
  c: string;
  m: ChannelDialogType;
  t: string;
};

type GiveawayLaunchPayload = {
  v: 1;
  k: 'giveaway';
  g: string;
};

type MiniappRouteLaunchPayload = {
  v: 1;
  k: 'route';
  r: string;
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSearchParam(source: string, names: readonly string[]): string {
  const normalized = source.trim().replace(/^[?#]/u, '');
  const directValue = readSearchParamFromNormalizedSource(normalized, names);
  if (directValue) {
    return directValue;
  }

  const queryIndex = normalized.indexOf('?');
  return queryIndex >= 0 ? readSearchParamFromNormalizedSource(normalized.slice(queryIndex + 1), names) : '';
}

function readSearchParamFromNormalizedSource(source: string, names: readonly string[]): string {
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
    readSearchParam(window.location.hash, names)
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
      (parsed.k !== 'channel-dialog' && parsed.k !== 'chat-dialog') ||
      !chatId ||
      !type ||
      token.length < 16 ||
      token.length > 256
    ) {
      return null;
    }

    return {
      v: 1,
      k: parsed.k,
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

function normalizeRouteLaunchPath(value: string): string | null {
  const normalized = readString(value);
  if (!normalized.startsWith('/')) {
    return null;
  }

  try {
    const parsed = new URL(normalized, 'https://miniapp.local');
    if (parsed.origin !== 'https://miniapp.local') {
      return null;
    }

    const pathname = parsed.pathname;
    if (pathname === '/') {
      return `${pathname}${parsed.search}`;
    }

    if (pathname === '/chats' && !parsed.search) {
      return '/';
    }

    if (pathname === '/system' && !parsed.search) {
      return pathname;
    }

    if (/^\/chat\/[^/?#]+\/events$/u.test(pathname) && !parsed.search) {
      return pathname;
    }

    if (/^\/channel\/[^/?#]+\/stats$/u.test(pathname) && !parsed.search) {
      return pathname;
    }

    if (/^\/chat\/[^/?#]+\/settings$/u.test(pathname)) {
      if (!hasAllowedSearchParams(parsed, CHAT_SETTINGS_FOCUS)) {
        return null;
      }
      return `${pathname}${parsed.search}`;
    }

    if (/^\/channel\/[^/?#]+\/settings$/u.test(pathname)) {
      if (!hasAllowedSearchParams(parsed, CHANNEL_SETTINGS_FOCUS)) {
        return null;
      }
      return `${pathname}${parsed.search}`;
    }

    return null;
  } catch {
    return null;
  }
}

function hasAllowedSearchParams(parsed: URL, allowedFocus: Set<string>): boolean {
  const focusValues = parsed.searchParams.getAll('focus');
  const handoffValues = parsed.searchParams.getAll('handoff');

  if (focusValues.length > 1 || handoffValues.length > 1) {
    return false;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (key === 'focus') {
      if (!allowedFocus.has(value)) {
        return false;
      }
      continue;
    }

    if (key === 'handoff') {
      if (value !== '1') {
        return false;
      }
      continue;
    }

    return false;
  }

  return true;
}

function parseMiniappRouteStartParam(value: string): string | null {
  const normalized = value.trim();
  if (!normalized.startsWith(MINIAPP_ROUTE_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(MINIAPP_ROUTE_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<MiniappRouteLaunchPayload>;
    if (parsed.v !== 1 || parsed.k !== 'route') {
      return null;
    }

    return normalizeRouteLaunchPath(parsed.r ?? '');
  } catch {
    return null;
  }
}

export function resolveLaunchRoute(initData: string): string | null {
  const startParam =
    readStartParamFromLocation() ||
    readStartParamFromBridge() ||
    readStartParamFromInitData(initData);

  const routeLaunch = parseMiniappRouteStartParam(startParam);
  if (routeLaunch) {
    return routeLaunch;
  }

  const giveawayLaunch = parseGiveawayStartParam(startParam);
  if (giveawayLaunch) {
    return `/giveaways/${encodeURIComponent(giveawayLaunch.g)}`;
  }

  const channelDialogLaunch = parseChannelDialogStartParam(startParam);
  if (!channelDialogLaunch) {
    return null;
  }

  const entitySegment = channelDialogLaunch.k === 'chat-dialog' ? 'chat' : 'channel';
  return `/${entitySegment}/${encodeURIComponent(channelDialogLaunch.c)}/dialog/${channelDialogLaunch.m}?token=${encodeURIComponent(channelDialogLaunch.t)}`;
}

export const resolveLaunchDialogRoute = resolveLaunchRoute;
