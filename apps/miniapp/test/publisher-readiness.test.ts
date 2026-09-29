import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PublisherEntityReadiness,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import { togglePublicationTargetSelection } from '../src/features/publications/publication-target-selection';
import type { PublicationTarget } from '../src/features/publications/publication-model';
import { createApiRequestError } from '../src/lib/api-request-error';
import { getPublisherReadinessPresentation } from '../src/lib/publisher-readiness';
import {
  canSelectInitialPublicationRouteTarget,
  classifyInitialPublicationTargetRequestError,
  getRouteBoundInitialPublicationTargetFailure,
  shouldFetchInitialPublisherTarget,
} from '../src/features/publications/use-initial-publication-target-route';
import {
  getPublisherDraftTargetsNeedingHydration,
  hasUnavailablePublisherDraftTargets,
  mergePublisherResolvedTargets,
} from '../src/features/publications/use-publisher-draft-target-hydration';

function readiness(
  blockerCode: PublisherReadinessBlockerCode | null,
  canPublish = blockerCode === null,
): PublisherEntityReadiness {
  return {
    state: canPublish
      ? 'ready'
      : blockerCode === 'policy_disabled'
        ? 'disabled'
        : blockerCode === 'publisher_runtime_unavailable' || blockerCode === 'route_quarantined'
          ? 'temporarily_unavailable'
          : 'setup_required',
    canPublish,
    canUseChatComments: false,
    canPublishSuggestions: false,
    blockerCode,
    checkedAt: null,
    retryAt: null,
  };
}

function target(id: string, targetReadiness: PublisherEntityReadiness): PublicationTarget {
  return {
    id,
    title: id,
    entityType: 'chat',
    avatarUrl: null,
    channelOverview: null,
    readiness: targetReadiness,
  };
}

test('publisher readiness presents every server blocker as a specific user-facing state', () => {
  const expected: Record<PublisherReadinessBlockerCode, string> = {
    policy_disabled: 'Публик выключен',
    bot_not_connected: 'Публик не добавлен',
    bot_access_unconfirmed: 'Проверяем доступ',
    bot_access_expired: 'Доступ нужно обновить',
    bot_not_admin: 'Публик не администратор',
    write_permission_missing: 'Нет права публиковать',
    route_quarantined: 'Отправка приостановлена',
    publisher_runtime_unavailable: 'Публик временно недоступен',
  };

  for (const [blockerCode, label] of Object.entries(expected)) {
    const presentation = getPublisherReadinessPresentation(
      readiness(blockerCode as PublisherReadinessBlockerCode),
    );
    assert.equal(presentation.label, label);
    assert.ok(presentation.detail.length > 0);
  }
  assert.equal(getPublisherReadinessPresentation(readiness(null)).label, 'Готов к публикации');
});

test('publisher readiness exposes required permissions and quarantine recovery time', () => {
  assert.match(
    getPublisherReadinessPresentation(readiness('write_permission_missing')).detail,
    /отправлять сообщения/u,
  );
  const quarantined = readiness('route_quarantined');
  quarantined.retryAt = '2026-08-27T12:30:00.000Z';
  assert.match(getPublisherReadinessPresentation(quarantined).detail, /Следующая проверка:/u);
});

test('an unavailable selected target can be removed from a stale draft', () => {
  const unavailable = target('chat-unavailable', readiness('bot_not_admin'));
  const result = togglePublicationTargetSelection([unavailable], unavailable);

  assert.equal(result.outcome, 'removed');
  assert.deepEqual(result.targets, []);
});

test('an unavailable target cannot be added and ready targets have no fixed count ceiling', () => {
  const ready = Array.from({ length: 501 }, (_, index) => target(`chat-${index}`, readiness(null)));
  const unavailable = target('chat-unavailable', readiness('write_permission_missing'));

  assert.deepEqual(togglePublicationTargetSelection([], unavailable), {
    targets: [],
    outcome: 'blocked_unavailable',
  });
  const result = togglePublicationTargetSelection(ready, target('chat-next', readiness(null)));
  assert.equal(result.outcome, 'added');
  assert.equal(result.targets.length, 502);
});

test('draft target hydration updates readiness and fails closed for a missing entity', () => {
  const stale = { ...target('chat-stale', readiness(null)), readiness: null };
  const missing = { ...target('chat-missing', readiness(null)), readiness: null };
  const resolved = target('chat-stale', readiness(null));

  const merged = mergePublisherResolvedTargets([stale, missing], [stale, missing], [resolved]);

  assert.equal(merged[0]?.readiness?.canPublish, true);
  assert.equal(merged[1]?.readiness, null);
});

test('draft hydration revalidates the restored set once and excludes fresh choices', () => {
  const restored = target('chat-restored', readiness('bot_access_expired'));
  const fresh = target('chat-fresh', readiness(null));
  const initialKeys = new Set(['chat:chat-restored']);

  assert.deepEqual(
    getPublisherDraftTargetsNeedingHydration([restored, fresh], initialKeys, new Set()),
    [restored],
  );
  assert.deepEqual(
    getPublisherDraftTargetsNeedingHydration(
      [restored, fresh],
      initialKeys,
      new Set(['chat:chat-restored']),
    ),
    [],
  );

  const merged = mergePublisherResolvedTargets(
    [restored, fresh],
    [restored],
    [target('chat-restored', readiness('bot_not_admin'))],
  );
  assert.equal(merged[0]?.readiness?.blockerCode, 'bot_not_admin');
  assert.equal(merged[1], fresh);
});

test('a failed restored-target check blocks stale ready metadata until retry succeeds', () => {
  const staleReady = target('chat-stale-ready', readiness(null));

  assert.equal(
    hasUnavailablePublisherDraftTargets({
      selectedTargets: [staleReady],
      currentTargets: [],
      hydrationFailed: true,
    }),
    true,
  );
});

test('a direct publisher target already present on the first page skips the disabled query', () => {
  assert.equal(
    shouldFetchInitialPublisherTarget({
      publisherProfile: true,
      hydrated: true,
      routeApplied: false,
      entityType: 'chat',
      entityId: 'chat-ready',
      targetInPages: true,
    }),
    false,
  );
});

test('direct publisher routes select ready targets and reject proven permission failures', () => {
  assert.equal(
    canSelectInitialPublicationRouteTarget(true, target('ready', readiness(null))),
    true,
  );
  assert.equal(
    canSelectInitialPublicationRouteTarget(
      true,
      target('not-ready', readiness('write_permission_missing')),
    ),
    false,
  );
  assert.equal(
    canSelectInitialPublicationRouteTarget(false, {
      ...target('moderation-target', readiness('bot_not_admin')),
      readiness: null,
    }),
    true,
  );
});

for (const blocker of ['bot_access_expired', 'bot_access_unconfirmed'] as const) {
  test(`${blocker} permits selection, restored-draft validation and direct entry for access recovery`, () => {
    const stale = target('stale', readiness(blocker));
    assert.equal(togglePublicationTargetSelection([], stale).outcome, 'added');
    assert.equal(canSelectInitialPublicationRouteTarget(true, stale), true);
    assert.equal(
      hasUnavailablePublisherDraftTargets({
        selectedTargets: [stale],
        currentTargets: [stale],
        hydrationFailed: false,
      }),
      false,
    );
    assert.equal(stale.readiness?.canPublish, false);
  });
}

test('missing metadata, disabled features and denied rights still block draft submission', () => {
  for (const state of [
    null,
    readiness('policy_disabled'),
    readiness('bot_not_admin'),
    readiness('write_permission_missing'),
    readiness('bot_not_connected'),
    readiness('route_quarantined'),
  ]) {
    const unavailable = { ...target('target', readiness(null)), readiness: state };
    assert.equal(
      hasUnavailablePublisherDraftTargets({
        selectedTargets: [unavailable],
        currentTargets: [unavailable],
        hydrationFailed: false,
      }),
      true,
    );
    assert.equal(canSelectInitialPublicationRouteTarget(true, unavailable), false);
  }
});

test('direct publisher route failures distinguish persistent and retryable requests', () => {
  assert.equal(
    classifyInitialPublicationTargetRequestError(
      createApiRequestError(404, '{"statusCode":404}', 'Not found'),
    ),
    'unavailable',
  );
  assert.equal(
    classifyInitialPublicationTargetRequestError(
      createApiRequestError(400, '{"statusCode":400}', 'Unavailable'),
    ),
    'unavailable',
  );
  assert.equal(
    classifyInitialPublicationTargetRequestError(
      createApiRequestError(503, '{"statusCode":503}', 'Unavailable'),
    ),
    'retryable',
  );
  assert.equal(
    classifyInitialPublicationTargetRequestError(
      createApiRequestError(429, '{"statusCode":429}', 'Retry later'),
    ),
    'retryable',
  );
  assert.equal(
    classifyInitialPublicationTargetRequestError(new TypeError('Network request failed')),
    'retryable',
  );
});

test('direct publisher failures are visible only for the route that produced them', () => {
  const failure = {
    routeKey: 'chat:chat-a',
    failure: {
      kind: 'retryable' as const,
      reason: 'request_failed' as const,
      error: new TypeError('Network request failed'),
    },
  };

  assert.equal(
    getRouteBoundInitialPublicationTargetFailure(failure, 'chat:chat-a'),
    failure.failure,
  );
  assert.equal(getRouteBoundInitialPublicationTargetFailure(failure, 'chat:chat-b'), null);
  assert.equal(getRouteBoundInitialPublicationTargetFailure(null, 'chat:chat-a'), null);
});
