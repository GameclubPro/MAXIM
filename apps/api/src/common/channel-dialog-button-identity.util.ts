export type InternalChannelDialogButtonIdentity = {
  chatId: string;
  kind: 'comments' | 'suggest';
  threadId: string | null;
};

const TRUSTED_DIRECT_CHANNEL_DIALOG_HOSTS = new Set([
  'major-maksimov.ru',
  'app.major-maksimov.ru',
  'maxim.play-team.ru',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

export function readInternalChannelDialogButtonIdentity(
  value: unknown,
): InternalChannelDialogButtonIdentity | null {
  const button = asRecord(value);
  const type = readLowerString(button?.type) ?? (button?.url !== undefined ? 'link' : null);
  const rawUrl =
    type === 'link'
      ? readString(button?.url)
      : type === 'open_app'
        ? readString(button?.web_app ?? button?.webApp)
        : null;
  if (!rawUrl) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }

  const directIdentity = readDirectChannelDialogIdentity(url);
  if (directIdentity) {
    return directIdentity;
  }

  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'max.ru') {
    return null;
  }

  return (
    readChannelDialogStartIdentity(url.searchParams.get('startapp')) ??
    readChannelDialogStartIdentity(url.searchParams.get('start'))
  );
}

export function internalChannelDialogButtonIdentityKey(
  identity: InternalChannelDialogButtonIdentity,
): string {
  return JSON.stringify([identity.chatId, identity.kind]);
}

export function readInternalChannelDialogButtonIdentitiesFromMessage(
  value: unknown,
  expectedChatId?: string,
): InternalChannelDialogButtonIdentity[] {
  const message = asRecord(value);
  const body = asRecord(message?.body);
  const attachmentGroups = [body?.attachments, message?.attachments];
  const identities: InternalChannelDialogButtonIdentity[] = [];
  const seen = new Set<string>();

  for (const attachments of attachmentGroups) {
    if (!Array.isArray(attachments)) {
      continue;
    }
    for (const attachment of attachments) {
      const row = asRecord(attachment);
      if (readLowerString(row?.type) !== 'inline_keyboard') {
        continue;
      }
      const payload = asRecord(row?.payload);
      const buttonRows = Array.isArray(payload?.buttons) ? payload.buttons : [];
      for (const buttonRow of buttonRows) {
        if (!Array.isArray(buttonRow)) {
          continue;
        }
        for (const button of buttonRow) {
          const identity = readInternalChannelDialogButtonIdentity(button);
          if (!identity || (expectedChatId && identity.chatId !== expectedChatId)) {
            continue;
          }
          const key = JSON.stringify([identity.chatId, identity.kind, identity.threadId]);
          if (!seen.has(key)) {
            seen.add(key);
            identities.push(identity);
          }
        }
      }
    }
  }

  return identities;
}

function readDirectChannelDialogIdentity(url: URL): InternalChannelDialogButtonIdentity | null {
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !TRUSTED_DIRECT_CHANNEL_DIALOG_HOSTS.has(url.hostname.toLowerCase())
  ) {
    return null;
  }

  const match = /^\/app\/channel\/([^/]+)\/dialog\/(comments|suggest)\/?$/u.exec(url.pathname);
  const token = readString(url.searchParams.get('token'));
  if (!match || !token || !isChannelDialogToken(token)) {
    return null;
  }
  const threadId = readChannelDialogTokenThreadId(token);
  if (!threadId && !/^[a-f0-9]{64}$/iu.test(token)) {
    return null;
  }

  try {
    const chatId = decodeURIComponent(match[1]!).trim();
    return chatId
      ? {
          chatId,
          kind: match[2] as InternalChannelDialogButtonIdentity['kind'],
          threadId,
        }
      : null;
  } catch {
    return null;
  }
}

function readChannelDialogStartIdentity(
  startParam: string | null,
): InternalChannelDialogButtonIdentity | null {
  const normalized = readString(startParam);
  if (!normalized) {
    return null;
  }

  if (normalized.startsWith('cds-')) {
    const match = /^cds-(.+)\.([a-f0-9]{32})\.([a-f0-9]{24})$/u.exec(normalized);
    const chatId = match?.[1]?.trim() ?? '';
    return chatId ? { chatId, kind: 'suggest', threadId: expandCompactThreadId(match![2]!) } : null;
  }

  if (!normalized.startsWith('cd-')) {
    return null;
  }

  try {
    const payload = asRecord(
      JSON.parse(Buffer.from(normalized.slice('cd-'.length), 'base64url').toString('utf8')),
    );
    const chatId = readString(payload?.c);
    const kind = readLowerString(payload?.m);
    const token = readString(payload?.t);
    if (
      payload?.v !== 1 ||
      payload.k !== 'channel-dialog' ||
      !chatId ||
      (kind !== 'comments' && kind !== 'suggest') ||
      !token ||
      !isChannelDialogToken(token)
    ) {
      return null;
    }
    const threadId = readChannelDialogTokenThreadId(token);
    if (!threadId && !/^[a-f0-9]{64}$/iu.test(token)) {
      return null;
    }
    return { chatId, kind, threadId };
  } catch {
    return null;
  }
}

function readChannelDialogTokenThreadId(token: string): string | null {
  if (!token.startsWith('cdt-')) {
    return null;
  }
  try {
    const payload = asRecord(
      JSON.parse(Buffer.from(token.slice('cdt-'.length), 'base64url').toString('utf8')),
    );
    const threadId = readString(payload?.d);
    const signature = readString(payload?.s);
    return payload?.v === 1 && threadId && signature && /^[a-f0-9]{64}$/iu.test(signature)
      ? threadId
      : null;
  } catch {
    return null;
  }
}

function expandCompactThreadId(value: string): string {
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

function isChannelDialogToken(value: string): boolean {
  return /^cdt-[A-Za-z0-9_-]+$/u.test(value) || /^[a-f0-9]{64}$/iu.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readLowerString(value: unknown): string | null {
  return readString(value)?.toLowerCase() ?? null;
}
