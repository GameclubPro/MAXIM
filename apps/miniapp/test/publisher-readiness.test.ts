import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  PublisherEntityReadiness,
  PublisherReadinessBlockerCode,
} from '@maxim/contracts/publisher';
import { togglePublicationTargetSelection } from '../src/features/publications/publication-target-selection';
import type { PublicationTarget } from '../src/features/publications/publication-model';
import { getPublisherReadinessPresentation } from '../src/lib/publisher-readiness';

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
  assert.deepEqual(togglePublicationTargetSelection([ready], target('chat-2', readiness(null)), 1), {
    targets: [ready],
    outcome: 'blocked_limit',
  });
});
