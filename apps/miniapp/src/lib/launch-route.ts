import type { ChannelDialogType } from '@maxim/contracts';

const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';

type ChannelDialogLaunchPayload = {
  v: 1;
  k: 'channel-dialog';
  c: string;
  m: ChannelDialogType;
  t: string;
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
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<ChannelDialogLaunchPayload>;
    const chatId = readString(parsed.c);
    const type = parsed.m === 'suggest' ? 'suggest' : parsed.m === 'comments' ? 'comments' : null;
    const token = readString(parsed.t).toLowerCase();
    if (
      parsed.v !== 1 ||
      parsed.k !== 'channel-dialog' ||
      !chatId ||
      !type ||
      !/^[a-f0-9]{64}$/u.test(token)
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

export function resolveLaunchDialogRoute(initData: string): string | null {
  const startParam =
    readStartParamFromLocation() || readStartParamFromBridge() || readStartParamFromInitData(initData);
  const launch = parseChannelDialogStartParam(startParam);
  if (!launch) {
    return null;
  }

  return `/channel/${encodeURIComponent(launch.c)}/dialog/${launch.m}?token=${encodeURIComponent(launch.t)}`;
}
