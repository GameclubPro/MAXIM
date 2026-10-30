import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { marketplaceProfileStateSchema } from '@maxim/contracts/marketplace-integration';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('automatic marketplace readiness preserves separate publication and append policy in both profiles', async () => {
  const closed = createPreviewApiTransport();
  assert.deepEqual(await closed.request('/marketplace/capability'), { available: true });
  for (const profile of ['moderation', 'publisher']) {
    const api = createPreviewApiTransport({ search: `?marketplacePilot=1&profile=${profile}` });
    for (const kind of ['CHAT', 'CHANNEL']) {
      const path = `/marketplace/entities/${kind}/${kind === 'CHAT' ? 'preview-chat' : 'preview-channel'}/profile?profile=${profile}`;
      const initial = marketplaceProfileStateSchema.parse(await api.request(path));
      assert.equal(initial.listing, null);
      assert.equal(initial.binding.statisticsConsent, true);
      assert.equal(initial.appendEnabled, false);
      const body = {
        requestId: randomUUID(),
        action: 'save',
        expectedRevision: 0,
        details: {
          title: 'Площадка',
          description: '',
          topic: initial.choices.topics[0],
          region: initial.choices.regions[0],
        },
      };
      const create = body;
      const draft = marketplaceProfileStateSchema.parse(
        await api.request(path, { method: 'POST', body: JSON.stringify(create) }),
      );
      assert.equal(draft.listing?.status, 'DRAFT');
      assert.equal(draft.listing?.profileOnly, true);
      assert.equal(draft.appendEnabled, false);
      assert.deepEqual(
        await api.request(path, { method: 'POST', body: JSON.stringify(create) }),
        draft,
      );
      const published = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'publish',
            expectedRevision: draft.revision,
          }),
        }),
      );
      assert.equal(published.listing?.status, 'PUBLISHED');
      assert.equal(published.appendEnabled, false);
      const enabled = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'toggle',
            expectedRevision: published.appendRevision,
            appendEnabled: true,
          }),
        }),
      );
      assert.equal(enabled.appendEnabled, true);
      const revoked = marketplaceProfileStateSchema.parse(
        await api.request(path, {
          method: 'POST',
          body: JSON.stringify({
            requestId: randomUUID(),
            action: 'revoke',
            expectedRevision: enabled.appendRevision,
          }),
        }),
      );
      assert.equal(revoked.binding.state, 'REVOKED');
      assert.equal(revoked.binding.statisticsConsent, false);
      assert.equal(revoked.appendEnabled, false);
      assert.equal(revoked.listing?.status, 'PUBLISHED');
      assert.equal(revoked.listing?.publicUrl, null);
    }
  }
});

test('automatic readiness arrives independently of profile mutations and never publishes or appends', async () => {
  const api = createPreviewApiTransport({ search: '?marketplacePilot=1&marketplaceReady=delayed' });
  const path = '/marketplace/entities/CHANNEL/preview-channel/profile?profile=moderation';
  const initial = marketplaceProfileStateSchema.parse(await api.request(path));
  assert.equal(initial.binding.statisticsConsent, false);
  const create = {
    action: 'save',
    requestId: randomUUID(),
    expectedRevision: initial.revision,
    details: { title: 'Test', description: '', topic: 'Бизнес', region: 'Россия' },
  };
  assert.ok(!('statisticsConsent' in create));
  await assert.rejects(
    api.request(path, { method: 'POST', body: JSON.stringify(create) }),
    /Подтвердите/u,
  );
  const ready = marketplaceProfileStateSchema.parse(await api.request(path));
  assert.equal(ready.binding.statisticsConsent, true);
  assert.equal(ready.listing, null);
  assert.equal(ready.appendEnabled, false);
  const draft = marketplaceProfileStateSchema.parse(
    await api.request(path, { method: 'POST', body: JSON.stringify(create) }),
  );
  assert.equal(draft.listing?.status, 'DRAFT');
  assert.equal(draft.appendEnabled, false);
});

test('profile readiness distinguishes availability, public visibility and placement setup', async () => {
  const { marketplaceProfileView } = await import('../src/lib/marketplace-profile-view');
  const api = createPreviewApiTransport({ search: '?marketplacePilot=1&profile=publisher' });
  const path = '/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher';
  const state = marketplaceProfileStateSchema.parse(await api.request(path));
  assert.equal(marketplaceProfileView(state).title, 'Новый профиль · не сохранён');
  state.listing = {
    id: state.binding.id,
    status: 'PUBLISHED',
    title: 'Test',
    description: '',
    topic: 'Test',
    region: 'Test',
    publicUrl: 'https://max.ru/test',
    profileOnly: false,
  };
  state.binding.statisticsConsent = true;
  state.capabilities = {
    canEdit: true,
    canPublish: true,
    canPause: true,
    publicState: 'PUBLIC',
    placementState: 'SETUP_REQUIRED',
    manageUrl: null,
    connectUrl: 'https://max.ru/test',
  };
  assert.equal(marketplaceProfileView(state).placement, 'SETUP_REQUIRED');
  assert.equal(marketplaceProfileView(state).publicNow, true);
  state.capabilities.publicState = 'REVIEW';
  assert.equal(marketplaceProfileView(state).publicNow, false);
  assert.equal(marketplaceProfileView(state).title, 'Профиль на проверке биржи');
  state.binding.statisticsConsent = false;
  state.statistics = {
    state: 'DISABLED',
    observedDays: 0,
    lastObservedAt: null,
    from: null,
    to: null,
  };
  state.capabilities.publicState = 'PUBLIC';
  assert.equal(
    marketplaceProfileView(state).publicNow,
    false,
    'A stale public capability cannot restore unavailable access',
  );
  assert.equal(
    marketplaceProfileView(state).canPause,
    true,
    'Hiding never requires statistics consent',
  );
  assert.equal(marketplaceProfileView(state).canPublish, false);
  assert.equal(marketplaceProfileView(state).canAppend, false);
  assert.equal(
    marketplaceProfileView(state, false).canEdit,
    false,
    'Stale cached rights do not enable editing',
  );
  assert.equal(marketplaceProfileView(state, false).canPause, false);
  delete state.capabilities;
  assert.equal(
    marketplaceProfileView(state).canPublish,
    false,
    'Older server cannot imply visibility',
  );
  assert.equal(marketplaceProfileView(state).placement, 'UNAVAILABLE');
});

test('ordinary analytics availability needs no separate consent and never overrides an explicit unavailable profile', async () => {
  const { marketplaceProfileView, marketplaceProfileAvailable } =
    await import('../src/lib/marketplace-profile-view');
  const api = createPreviewApiTransport({ search: '?marketplacePilot=1&profile=publisher' });
  const state = marketplaceProfileStateSchema.parse(
    await api.request('/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher'),
  );
  state.binding.statisticsConsent = false;
  state.binding.state = 'ACTIVE';
  state.statistics = {
    state: 'EMPTY',
    observedDays: 0,
    lastObservedAt: null,
    from: null,
    to: null,
  };
  state.capabilities = {
    canEdit: true,
    canPublish: true,
    canPause: false,
    publicState: 'DRAFT',
    placementState: 'BOT_REQUIRED',
    manageUrl: null,
    connectUrl: 'https://max.ru/test',
  };
  assert.equal(marketplaceProfileAvailable(state), true);
  assert.equal(marketplaceProfileView(state).canPublish, true);
  assert.equal(state.binding.statisticsConsent, false, 'Compatibility policy is preserved');
  state.statistics.state = 'DISABLED';
  assert.equal(marketplaceProfileView(state).canPublish, false);
  state.statistics.state = 'EMPTY';
  state.binding.state = 'REVOKED';
  assert.equal(marketplaceProfileView(state).canPublish, false);
});

test('profile errors hide internal exchange requirements while preserving actionable conflicts', async () => {
  const { marketplaceProfileError } = await import('../src/lib/marketplace-profile-view');
  const fallback = 'Не удалось сохранить изменение. Проверьте состояние и повторите.';
  for (const message of [
    'Подтвердите использование статистики',
    'Согласие на статистику изменилось',
    'Обмен с MAXIM недоступен',
  ]) {
    assert.equal(marketplaceProfileError(new Error(message), fallback), fallback);
  }
  assert.equal(
    marketplaceProfileError(new Error('Профиль изменился. Обновите экран'), fallback),
    'Профиль изменился. Обновите экран',
  );
});

test('initial permission checks use typed pending codes and a bounded retry budget', async () => {
  const { isMarketplaceAccessPending, marketplaceRetryInterval } =
    await import('../src/lib/marketplace-profile-view');
  const { ApiRequestError } = await import('../src/lib/api-request-error');
  assert.equal(isMarketplaceAccessPending(new Error('Проверяем права')), false);
  assert.equal(
    isMarketplaceAccessPending(
      new ApiRequestError(
        503,
        JSON.stringify({ code: 'MARKETPLACE_ACCESS_PENDING' }),
        'Network text',
      ),
    ),
    true,
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((attempt) => marketplaceRetryInterval(attempt, true)),
    [5000, 10000, 20000, 30000, false, false],
  );
  assert.equal(marketplaceRetryInterval(20, false), 60_000);
});

test('legacy refresh, hide and explicit reconnect preserve independent publication policy', async () => {
  const api = createPreviewApiTransport({
    search: '?marketplacePilot=1&profile=publisher&marketplaceReady=0',
  });
  const path = '/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher';
  let state = marketplaceProfileStateSchema.parse(await api.request(path));
  const mutate = async (action: string, extra: object = {}) => {
    state = marketplaceProfileStateSchema.parse(
      await api.request(path, {
        method: 'POST',
        body: JSON.stringify({
          action,
          requestId: randomUUID(),
          expectedRevision:
            action === 'toggle' || action === 'revoke' ? state.appendRevision : state.revision,
          ...extra,
        }),
      }),
    );
  };
  await mutate('save', {
    statisticsConsent: true,
    details: { title: 'Test', description: '', topic: 'Бизнес', region: 'Россия' },
  });
  await mutate('publish');
  await mutate('toggle', { appendEnabled: true });
  await mutate('revoke');
  state = marketplaceProfileStateSchema.parse(await api.request(path));
  assert.equal(state.binding.state, 'ACTIVE');
  assert.equal(state.binding.statisticsConsent, false);
  assert.equal(state.listing?.publicUrl, null);
  assert.equal(state.capabilities?.canPause, true);
  await mutate('pause');
  assert.equal(state.binding.statisticsConsent, false);
  assert.equal(state.listing?.status, 'PAUSED');
  await mutate('save', {
    statisticsConsent: true,
    details: { title: 'Test', description: '', topic: 'Бизнес', region: 'Россия' },
  });
  assert.equal(state.appendEnabled, false);
  assert.equal(state.listing?.status, 'PAUSED');
});

test('legacy policy replies retain presentation but never revive revoked rights or consent', async () => {
  const { mergeMarketplaceMutationState, marketplaceProfileView } =
    await import('../src/lib/marketplace-profile-view');
  const api = createPreviewApiTransport({ search: '?marketplacePilot=1&profile=publisher' });
  const previous = marketplaceProfileStateSchema.parse(
    await api.request('/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher'),
  );
  previous.binding.statisticsConsent = true;
  previous.capabilities!.publicState = 'PUBLIC';
  const revoked = structuredClone(previous);
  delete revoked.capabilities;
  delete revoked.statistics;
  revoked.binding.state = 'REVOKED';
  revoked.binding.statisticsConsent = false;
  revoked.appendEnabled = false;
  const merged = mergeMarketplaceMutationState(revoked, previous);
  assert.deepEqual(merged.capabilities, previous.capabilities);
  assert.equal(merged.binding.statisticsConsent, false);
  assert.equal(marketplaceProfileView(merged).canEdit, false);
  assert.equal(marketplaceProfileView(merged).canAppend, false);
});

test('owner overview keeps public viewing separate from placement setup and conditions', async () => {
  const { marketplaceProfileOverview } = await import('../src/lib/marketplace-profile-view');
  const api = createPreviewApiTransport({ search: '?marketplacePublished=1&profile=publisher' });
  const state = marketplaceProfileStateSchema.parse(
    await api.request('/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher'),
  );
  const caps = state.capabilities!;
  caps.placementState = 'SETUP_REQUIRED';
  assert.equal(
    marketplaceProfileOverview(state).primary?.kind,
    'listing',
    'A published profile remains the primary destination while placements need setup',
  );
  caps.placementState = 'READY';
  let overview = marketplaceProfileOverview(state);
  assert.equal(overview.status, 'Профиль опубликован');
  assert.equal(overview.primary?.kind, 'listing');
  assert.equal(overview.primary?.label, 'Посмотреть профиль');
  assert.equal(overview.conditionsAction?.kind, 'manage');
  assert.equal(overview.conditionsAction?.label, 'Условия размещений');
  assert.equal(overview.placementAction, null);
  assert.equal(overview.placementNote, null, 'Readiness is not proof of commercial terms');

  caps.placementState = 'SETUP_REQUIRED';
  overview = marketplaceProfileOverview(state);
  assert.equal(overview.primary?.kind, 'listing');
  assert.equal(overview.placementNote, 'Требуется настройка размещений');
  assert.equal(overview.placementAction?.kind, 'manage');
  assert.equal(
    overview.conditionsAction,
    null,
    'Setup and conditions do not duplicate one destination',
  );

  caps.placementState = 'BOT_REQUIRED';
  overview = marketplaceProfileOverview(state);
  assert.equal(overview.primary?.kind, 'listing');
  assert.equal(overview.placementNote, 'Размещения через Биржик не подключены');
  assert.equal(overview.placementAction?.kind, 'connect');
  assert.equal(overview.conditionsAction?.kind, 'manage');

  caps.connectUrl = null;
  overview = marketplaceProfileOverview(state);
  assert.equal(overview.primary?.kind, 'listing');
  assert.equal(overview.placementAction, null, 'An unavailable connection URL is not invented');

  caps.placementState = 'UNAVAILABLE';
  overview = marketplaceProfileOverview(state);
  assert.equal(overview.primary?.kind, 'listing');
  assert.equal(overview.placementNote, 'Размещения пока недоступны');
  assert.equal(overview.conditionsAction?.kind, 'manage');
  caps.placementState = 'READY';
  caps.publicState = 'HIDDEN';
  state.listing!.status = 'PAUSED';
  state.listing!.publicUrl = null;
  overview = marketplaceProfileOverview(state);
  assert.deepEqual(
    overview.primary,
    {
      kind: 'profile',
      label: 'Настройки карточки',
    },
    'A hidden profile opens editable fields without publishing',
  );
  assert.equal(overview.placementAction, null);
  assert.equal(overview.conditionsAction, null);
  assert.equal(overview.showProfileSettings, false, 'The main profile action is not duplicated');

  caps.publicState = 'REVIEW';
  assert.equal(marketplaceProfileOverview(state).primary, null);
  const { marketplaceProfileView } = await import('../src/lib/marketplace-profile-view');
  assert.equal(
    marketplaceProfileView(state).canPublish,
    false,
    'Review blocks a stale positive publication capability',
  );
  caps.publicState = 'DRAFT';
  state.listing!.status = 'DRAFT';
  assert.equal(marketplaceProfileOverview(state).primary?.kind, 'publish');
  state.listing!.topic = '';
  assert.deepEqual(
    marketplaceProfileOverview(state).primary,
    {
      kind: 'profile',
      label: 'Продолжить настройку',
    },
    'An incomplete draft leads directly to editable fields',
  );
  state.listing = null;
  assert.equal(marketplaceProfileOverview(state).primary?.label, 'Создать карточку площадки');
});

test('expired owner access never presents current visibility or permits profile writes', async () => {
  const { marketplaceProfileView, marketplaceProfileOverview } =
    await import('../src/lib/marketplace-profile-view');
  const api = createPreviewApiTransport({ search: '?marketplacePublished=1&profile=publisher' });
  const state = marketplaceProfileStateSchema.parse(
    await api.request('/marketplace/entities/CHANNEL/preview-channel/profile?profile=publisher'),
  );
  state.capabilities!.placementState = 'READY';
  state.binding.validUntil = new Date(Date.now() - 1).toISOString();
  const expired = marketplaceProfileView(state);
  assert.equal(expired.active, false);
  assert.equal(expired.publicNow, false);
  assert.equal(expired.canEdit, false);
  assert.equal(expired.canPublish, false);
  assert.equal(expired.canPause, false);
  assert.equal(marketplaceProfileOverview(state).primary?.kind, 'refresh');
  assert.equal(marketplaceProfileOverview(state).placementAction, null);
  assert.equal(marketplaceProfileOverview(state).conditionsAction, null);

  state.binding.validUntil = null;
  assert.equal(marketplaceProfileView(state).active, true, 'Preserve missing-expiry compatibility');
  assert.equal(marketplaceProfileOverview(state, false).primary?.kind, 'refresh');
  assert.equal(marketplaceProfileOverview(state, false).placementAction, null);
  assert.equal(marketplaceProfileOverview(state, false).conditionsAction, null);
});
