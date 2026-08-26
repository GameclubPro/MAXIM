import assert from 'node:assert/strict';
import test from 'node:test';
import {
  publisherEntitySchema,
  type PublisherEntity,
  type PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import {
  buildPublisherComposeRoute,
  getPublisherEntityCapabilities,
  isPublisherEntityRefreshObserved,
  normalizePublisherEntityView,
  pollPublisherEntityRefresh,
  resolvePublisherEntityPrimaryAction,
  shouldOfferPublisherRecheck,
} from '../src/pages/publisher-entities-page-model';

function publisherEntity(
  id: string,
  entityType: 'chat' | 'channel',
  options: {
    title?: string;
    ready?: boolean;
    blockerCode?: PublisherReadinessBlockerCode | null;
    suggestionsViaPublik?: boolean;
    checkedAt?: string | null;
    entityUrl?: string | null;
    settingsHandoffUrl?: string | null;
  } = {},
): PublisherEntity {
  const ready = options.ready ?? true;
  const blockerCode = ready ? null : (options.blockerCode ?? 'bot_not_connected');
  return publisherEntitySchema.parse({
    id,
    title: options.title ?? id,
    entityType,
    entityUrl: options.entityUrl ?? null,
    settingsHandoffUrl: options.settingsHandoffUrl ?? null,
    policy: {
      publikEnabled: blockerCode !== 'policy_disabled',
      suggestionsViaPublik: options.suggestionsViaPublik ?? false,
      revision: 0,
      updatedAt: null,
    },
    readiness: {
      state: ready
        ? 'ready'
        : blockerCode === 'publisher_runtime_unavailable' || blockerCode === 'route_quarantined'
          ? 'temporarily_unavailable'
          : blockerCode === 'policy_disabled'
            ? 'disabled'
            : 'setup_required',
      canPublish: ready,
      canUseChatComments: entityType === 'chat' && ready,
      canPublishSuggestions:
        entityType === 'channel' && ready && options.suggestionsViaPublik === true,
      blockerCode,
      checkedAt: options.checkedAt ?? null,
      retryAt: null,
    },
  });
}

test('publisher cabinet normalizes its server-side entity view', () => {
  assert.equal(normalizePublisherEntityView('channel'), 'channel');
  assert.equal(normalizePublisherEntityView('unknown'), 'chat');
});

test('publisher cabinet builds an encoded compose deep link', () => {
  const entity = publisherEntity('channel/with?symbols', 'channel');
  assert.equal(
    buildPublisherComposeRoute(entity),
    '/publications?compose=1&entityType=channel&entityId=channel%2Fwith%3Fsymbols',
  );
});

test('publisher cabinet maps every blocker to a truthful primary action', () => {
  const botDialogUrl = 'https://max.ru/publik-bot';
  const blockedChat = publisherEntity('chat-setup', 'chat', {
    ready: false,
    entityUrl: 'https://max.ru/join/chat-setup',
    settingsHandoffUrl: 'https://max.ru/entry?startapp=mr-settings',
  });
  assert.deepEqual(resolvePublisherEntityPrimaryAction(blockedChat, botDialogUrl), {
    kind: 'max_link',
    label: 'Открыть Публик',
    url: botDialogUrl,
  });
  assert.deepEqual(
    resolvePublisherEntityPrimaryAction(
      publisherEntity('chat-disabled', 'chat', {
        ready: false,
        blockerCode: 'policy_disabled',
        settingsHandoffUrl: 'https://max.ru/entry?startapp=mr-settings',
      }),
      botDialogUrl,
    ),
    {
      kind: 'max_link',
      label: 'Открыть настройки',
      url: 'https://max.ru/entry?startapp=mr-settings',
    },
  );
  for (const blockerCode of ['bot_not_admin', 'write_permission_missing'] as const) {
    assert.deepEqual(
      resolvePublisherEntityPrimaryAction(
        publisherEntity('channel-rights', 'channel', {
          ready: false,
          blockerCode,
          entityUrl: 'https://max.ru/channel/rights',
        }),
        botDialogUrl,
      ),
      {
        kind: 'max_link',
        label: 'Открыть канал',
        url: 'https://max.ru/channel/rights',
      },
    );
  }
  assert.deepEqual(
    resolvePublisherEntityPrimaryAction(
      publisherEntity('chat-unconfirmed', 'chat', {
        ready: false,
        blockerCode: 'bot_access_unconfirmed',
      }),
      botDialogUrl,
    ),
    { kind: 'note', label: 'Перепроверьте доступ' },
  );
  assert.deepEqual(
    resolvePublisherEntityPrimaryAction(
      publisherEntity('chat-admin', 'chat', {
        ready: false,
        blockerCode: 'bot_not_admin',
      }),
      botDialogUrl,
    ),
    { kind: 'note', label: 'Выдайте Публику права администратора в MAX' },
  );
  assert.deepEqual(
    resolvePublisherEntityPrimaryAction(publisherEntity('chat-ready', 'chat'), botDialogUrl),
    {
      kind: 'compose',
      label: 'Создать пост',
      href: '/publications?compose=1&entityType=chat&entityId=chat-ready',
    },
  );
});

test('publisher cabinet exposes rechecks only for access blockers and shows capabilities', () => {
  const blockedChat = publisherEntity('chat-setup', 'chat', { ready: false });
  const externalSuggestions = publisherEntity('channel-main', 'channel');
  const publikSuggestions = publisherEntity('channel-publik', 'channel', {
    suggestionsViaPublik: true,
  });

  assert.equal(shouldOfferPublisherRecheck(blockedChat), true);
  assert.equal(shouldOfferPublisherRecheck(externalSuggestions), false);
  assert.equal(
    shouldOfferPublisherRecheck(
      publisherEntity('channel-runtime', 'channel', {
        ready: false,
        blockerCode: 'publisher_runtime_unavailable',
      }),
    ),
    false,
  );
  assert.equal(
    shouldOfferPublisherRecheck(
      publisherEntity('channel-disabled', 'channel', {
        ready: false,
        blockerCode: 'policy_disabled',
      }),
    ),
    false,
  );
  assert.deepEqual(
    getPublisherEntityCapabilities(blockedChat).map(({ key, tone }) => [key, tone]),
    [
      ['posting', 'blocked'],
      ['comments', 'blocked'],
    ],
  );
  assert.equal(getPublisherEntityCapabilities(externalSuggestions)[1]?.tone, 'external');
  assert.equal(getPublisherEntityCapabilities(publikSuggestions)[1]?.tone, 'available');
});

test('publisher refresh polling uses targeted backoff until a newer access check is observed', async () => {
  const initial = publisherEntity('chat-setup', 'chat', { ready: false });
  const intermediate = publisherEntity('chat-setup', 'chat', {
    ready: false,
    blockerCode: 'bot_not_connected',
  });
  const updated = publisherEntity('chat-setup', 'chat', {
    checkedAt: '2026-08-27T10:00:01.000Z',
  });
  const transientReadError = new Error('temporary read failure');
  const reads: Array<PublisherEntity | Error> = [transientReadError, intermediate, updated];
  const waited: number[] = [];

  assert.equal(isPublisherEntityRefreshObserved(initial, intermediate), false);
  assert.equal(isPublisherEntityRefreshObserved(initial, updated), true);

  const result = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 250, 500],
    wait: async (delayMs) => {
      waited.push(delayMs);
    },
    readEntity: async () => {
      const next = reads.shift() ?? updated;
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  });

  assert.equal(result.status, 'updated');
  assert.equal(result.attempts, 3);
  assert.deepEqual(waited, [100, 250, 500]);
});

test('publisher refresh polling reports timeout separately from a final status read failure', async () => {
  const initial = publisherEntity('chat-ready', 'chat', {
    checkedAt: '2026-08-27T10:00:00.000Z',
  });
  const timedOut = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 200],
    wait: async () => undefined,
    readEntity: async () => initial,
  });
  assert.equal(timedOut.status, 'timed_out');
  assert.equal(timedOut.attempts, 2);

  const readError = new Error('status unavailable');
  const readFailed = await pollPublisherEntityRefresh({
    initialEntity: initial,
    delaysMs: [100, 200],
    wait: async () => undefined,
    readEntity: async () => {
      throw readError;
    },
  });
  assert.equal(readFailed.status, 'read_failed');
  assert.equal(readFailed.attempts, 2);
  assert.equal(readFailed.status === 'read_failed' ? readFailed.error : null, readError);
});
