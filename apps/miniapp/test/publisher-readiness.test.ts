import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PublisherEntityReadiness,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import { togglePublicationTargetSelection } from '../src/features/publications/publication-target-selection';
import type { PublicationTarget } from '../src/features/publications/publication-model';
import { getPublisherReadinessPresentation } from '../src/lib/publisher-readiness';
import { shouldFetchInitialPublisherTarget } from '../src/features/publications/use-initial-publication-target-route';
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
    /доступ ко всем сообщениям/u,
  );
  const quarantined = readiness('route_quarantined');
  quarantined.retryAt = '2026-08-27T12:30:00.000Z';
  assert.match(
    getPublisherReadinessPresentation(quarantined).detail,
    /восстановится автоматически после/u,
  );
});

test('an unavailable selected target can be removed from a stale draft', () => {
  const unavailable = target('chat-unavailable', readiness('bot_not_admin'));
  const result = togglePublicationTargetSelection([unavailable], unavailable);

  assert.equal(result.outcome, 'removed');
  assert.deepEqual(result.targets, []);
});

test('an unavailable target cannot be added and the target limit remains enforced', () => {
  const ready = target('chat-ready', readiness(null));
  const unavailable = target('chat-unavailable', readiness('write_permission_missing'));

  assert.deepEqual(togglePublicationTargetSelection([], unavailable), {
    targets: [],
    outcome: 'blocked_unavailable',
  });
  assert.deepEqual(
    togglePublicationTargetSelection([ready], target('chat-2', readiness(null)), 1),
    {
      targets: [ready],
      outcome: 'blocked_limit',
    },
  );
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
