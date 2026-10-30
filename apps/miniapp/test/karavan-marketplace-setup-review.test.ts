import assert from 'node:assert/strict';
import test from 'node:test';
import { changedMarketplaceSetupReview } from '../src/pages/settings/karavan-marketplace-setup-review';

type Review = Parameters<typeof changedMarketplaceSetupReview>[0];

function review(): Review {
  const marketplace: NonNullable<Review['target']>['marketplace'] = {
    id: '1f5469c8-bd55-45fa-9815-fe3b3462ef61',
    networkId: '8043d57c-b5f6-4eea-9e1d-909c63148bba',
    publicSlug: 'synthetic-marketplace',
    name: 'Магазин соседей',
    description: null,
    kind: 'chat',
    status: 'active',
    admissionPolicy: 'applications',
    logoImageUrl: null,
    coverImageUrl: null,
    editRevision: 1,
    policyRevision: 1,
    orderRevision: 1,
    visibilityRevision: 1,
  };
  const binding: NonNullable<Review['chats'][number]['binding']> = {
    id: '4aa065cc-669f-4b70-9ad0-a0924579c605',
    chatId: '-123',
    chatTitle: 'Соседи',
    state: 'verified',
    generation: 1,
    revision: 1,
    verifiedAt: '2026-10-30T12:00:00.000Z',
  };
  return {
    target: {
      marketplace,
      rules: {
        text: 'Правила магазина',
        allowedCategoryIds: ['services'],
        allowedSubcategoryIds: ['services.repair'],
        categoryOrder: ['services'],
        version: 1,
      },
      counts: { listings: 1, pendingApplications: 0, chats: 1 },
      permissions: ['bind_chat'],
      bindings: [binding],
    },
    chats: [{ chatId: '-123', title: 'Соседи', binding, marketplace }],
  };
}

test('setup needs fresh consent when reviewed marketplace rules change', () => {
  const original = review();
  const latest = review();
  latest.target!.marketplace.policyRevision++;
  latest.target!.rules.text = 'Обновлённые правила';
  assert.equal(changedMarketplaceSetupReview(original, latest), 'rules');
});

test('setup needs fresh consent after binding replacement, revocation, or scope change', () => {
  const original = review();
  for (const mutate of [
    (value: Review) => value.chats[0].binding!.generation++,
    (value: Review) => (value.chats[0].binding!.state = 'revoked'),
    (value: Review) => (value.chats[0].binding = null),
    (value: Review) => (value.chats[0].marketplace = null),
    (value: Review) => value.chats.push({ ...value.chats[0], chatId: '-124' }),
    (value: Review) => (value.target!.marketplace.id = '6c9a0340-8190-445d-960d-9b9d1e288c31'),
  ]) {
    const latest = review();
    mutate(latest);
    assert.equal(changedMarketplaceSetupReview(original, latest), 'connections');
  }
});

test('fresh counts and labels do not introduce an extra setup confirmation', () => {
  const original = review();
  const latest = review();
  latest.target!.counts.listings++;
  latest.target!.counts.pendingApplications++;
  latest.chats[0].title = 'Новое название чата';
  latest.chats[0].binding!.revision++;
  assert.equal(changedMarketplaceSetupReview(original, latest), null);
  assert.equal(
    changedMarketplaceSetupReview({ target: null, chats: [] }, { target: null, chats: [] }),
    null,
  );
});
