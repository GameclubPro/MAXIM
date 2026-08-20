import { AdminService } from './admin.service';

export async function flushAsyncTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, resolve, reject };
}

export function createLocalManagedEntityRow(options: {
  chatId: string;
  title: string;
  entityType: 'chat' | 'channel';
  createdAt?: string;
}) {
  return {
    chat_id: options.chatId,
    chat_title: options.title,
    chat_type: options.entityType,
    created_at: new Date(options.createdAt ?? '2026-03-02T10:00:00.000Z'),
  };
}

export function decodeBase64UrlJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

export function readButtonUrl(
  button: { url?: string; webApp?: string } | null | undefined,
): string {
  const url = typeof button?.webApp === 'string' ? button.webApp : button?.url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('Button URL is missing');
  }

  return url;
}

export function readDialogButtonToken(
  button: { url?: string; webApp?: string } | null | undefined,
): string {
  const url = new URL(readButtonUrl(button));
  const directToken = url.searchParams.get('token');
  if (directToken) {
    return directToken;
  }

  const startParam = url.searchParams.get('startapp');
  if (!startParam?.startsWith('cd-')) {
    throw new Error('Dialog launch payload is missing');
  }

  const launch = decodeBase64UrlJson<{ t: string }>(startParam.slice(3));
  return launch.t;
}

export async function publishCommentsDialogToken(
  service: AdminService,
  maxClient: { sendMessageImmediateWithResolvedLink: jest.Mock },
) {
  await service.publishChannelEngagementMessage(
    'channel-1',
    {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    },
    {
      text: 'Нажмите кнопку ниже.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить пост',
    },
  );

  const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
  return readDialogButtonToken(options.buttons?.[0]?.[0]);
}

export async function publishSuggestDialogToken(
  service: AdminService,
  maxClient: { sendMessageImmediateWithResolvedLink: jest.Mock },
) {
  await service.publishChannelEngagementMessage(
    'channel-1',
    {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    },
    {
      text: 'Нажмите кнопку ниже.',
      commentsButtonText: 'Комментарии',
      suggestButtonText: 'Предложить пост',
    },
  );

  const [, , options] = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0] ?? [];
  const suggestButton = options.buttons?.[0]?.[0];
  const suggestStartParam = new URL(readButtonUrl(suggestButton)).searchParams.get('start');
  if (suggestStartParam) {
    const parsedSuggestion = service.parseChannelSuggestionStartPayload(suggestStartParam);
    if (!parsedSuggestion) {
      throw new Error('Expected bot suggestion start payload');
    }
    return parsedSuggestion.token;
  }

  return readDialogButtonToken(suggestButton);
}
