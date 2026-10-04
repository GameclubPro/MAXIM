import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { marketplaceProfileStateSchema } from '@maxim/contracts/marketplace-integration';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('marketplace pilot preview requires consent, separate publication, and independent append policy in both profiles', async () => {
  const closed = createPreviewApiTransport();
  assert.deepEqual(await closed.request('/marketplace/capability'), { available: false });
  for (const profile of ['moderation', 'publisher']) {
    const api = createPreviewApiTransport({ search: `?marketplacePilot=1&profile=${profile}` });
    for (const kind of ['CHAT', 'CHANNEL']) {
      const path = `/marketplace/entities/${kind}/${kind === 'CHAT' ? 'preview-chat' : 'preview-channel'}/profile?profile=${profile}`;
      const initial = marketplaceProfileStateSchema.parse(await api.request(path));
      assert.equal(initial.listing, null);
      assert.equal(initial.binding.statisticsConsent, false);
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
      await assert.rejects(
        api.request(path, { method: 'POST', body: JSON.stringify(body) }),
        /Подтвердите/u,
      );
      const create = { ...body, statisticsConsent: true };
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

test('profile readiness distinguishes consent, public visibility and placement setup', async () => {
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

test('refresh, hide and reconnect never silently restore statistics consent or the publication button', async () => {
  const api = createPreviewApiTransport({ search: '?marketplacePilot=1&profile=publisher' });
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
