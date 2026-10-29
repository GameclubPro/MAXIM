import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  marketplaceEntryResponseSchema,
  marketplaceButtonPolicyStateSchema,
} from '@maxim/contracts/marketplace-integration';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { marketplaceTargetFromLink, BIRZHIK_BOT_URL } from '../src/lib/marketplace-launch';
import { mergeMarketplaceButtonPolicy } from '../src/lib/marketplace-button-policy';

const base = '/marketplace/entities/CHAT/preview-chat';

test('second administrator can configure public profile button without receiving owner editing', async () => {
  const api = createPreviewApiTransport({ search: '?marketplaceOwner=0' });
  const entry = marketplaceEntryResponseSchema.parse(
    await api.request(`${base}/entry?profile=moderation`),
  );
  assert.equal(entry.isOwner, false);
  assert.equal(entry.canCreate, false);
  assert.equal(entry.manageUrl, null);
  assert.equal(entry.publicState, 'PUBLIC');
  assert.match(entry.listing!.publicUrl!, /startapp=listing_chat_/u);
  await assert.rejects(api.request(`${base}/profile?profile=moderation`), /владелец/u);
  const path = `${base}/button-policy?profile=moderation`;
  const initial = marketplaceButtonPolicyStateSchema.parse(await api.request(path));
  assert.deepEqual(
    initial.contexts.map((item) => [item.context, item.enabled]),
    [
      ['GREETINGS', false],
      ['MODERATION_NOTICES', false],
    ],
  );
  const input = {
    requestId: randomUUID(),
    expectedRevision: initial.revision,
    context: 'MODERATION_NOTICES',
    enabled: true,
  };
  const enabled = marketplaceButtonPolicyStateSchema.parse(
    await api.request(path, { method: 'POST', body: JSON.stringify(input) }),
  );
  assert.equal(
    enabled.contexts.find((item) => item.context === 'MODERATION_NOTICES')?.effective,
    true,
  );
  assert.equal(enabled.contexts.find((item) => item.context === 'GREETINGS')?.enabled, false);
  assert.deepEqual(
    await api.request(path, { method: 'POST', body: JSON.stringify(input) }),
    enabled,
  );
  await assert.rejects(
    api.request(path, {
      method: 'POST',
      body: JSON.stringify({ ...input, requestId: randomUUID(), enabled: false }),
    }),
    /изменились/u,
  );
  await assert.rejects(
    api.request(path, { method: 'POST', body: JSON.stringify({ ...input, enabled: false }) }),
    /использован/u,
  );
  const publisher = marketplaceButtonPolicyStateSchema.parse(
    await api.request(`${base}/button-policy?profile=publisher`),
  );
  assert.deepEqual(
    publisher.contexts.map((item) => [item.context, item.enabled]),
    [['PUBLICATIONS', false]],
  );
});

test('channel button and publication policy remain separate and reject wrong contexts', async () => {
  const api = createPreviewApiTransport({ search: '?marketplacePublished=1' });
  const path = '/marketplace/entities/CHANNEL/preview-channel/button-policy?profile=moderation';
  const initial = marketplaceButtonPolicyStateSchema.parse(await api.request(path));
  assert.deepEqual(
    initial.contexts.map((item) => item.context),
    ['CHANNEL_POSTS'],
  );
  await assert.rejects(
    api.request(path, {
      method: 'POST',
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: 0,
        context: 'PUBLICATIONS',
        enabled: true,
      }),
    }),
    /недоступно/u,
  );
  const newer = { ...initial, revision: 3 };
  assert.equal(mergeMarketplaceButtonPolicy(initial, newer), newer);
});

test('marketplace links preserve exact entity kind and reject foreign or malformed destinations', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  assert.deepEqual(
    marketplaceTargetFromLink(`${BIRZHIK_BOT_URL}?startapp=manage_chat_${id}`, 'CHAT', '-100'),
    { target: 'manage', kind: 'CHAT', entityId: '-100', listingId: id },
  );
  assert.deepEqual(
    marketplaceTargetFromLink(
      `${BIRZHIK_BOT_URL}?startapp=connect_channel_-100`,
      'CHANNEL',
      '-100',
    ),
    { target: 'connect', kind: 'CHANNEL', entityId: '-100' },
  );
  for (const url of [
    `https://example.com/?startapp=manage_chat_${id}`,
    `${BIRZHIK_BOT_URL}?startapp=manage_channel_${id}`,
    `${BIRZHIK_BOT_URL}?startapp=manage_chat_not-a-uuid`,
    `${BIRZHIK_BOT_URL}?startapp=connect_chat_-200`,
    `https://user@max.ru/id613000037577_3_bot?startapp=manage_chat_${id}`,
  ])
    assert.equal(marketplaceTargetFromLink(url, 'CHAT', '-100'), null);
});

test('advertising caption is shared across profiles while module selections remain independent', async () => {
  const api = createPreviewApiTransport({ search: '?marketplacePublished=1' });
  const path = `${base}/button-policy?profile=moderation`;
  await api.request(path, {
    method: 'POST',
    body: JSON.stringify({
      requestId: randomUUID(),
      expectedCaptionRevision: 0,
      caption: 'Реклама здесь',
    }),
  });
  const publisher = marketplaceButtonPolicyStateSchema.parse(
    await api.request(`${base}/button-policy?profile=publisher`),
  );
  assert.equal(publisher.caption, 'Реклама здесь');
  assert.equal(publisher.captionRevision, 1);
  const group = marketplaceButtonPolicyStateSchema.parse(
    await api.request(path, {
      method: 'POST',
      body: JSON.stringify({
        requestId: randomUUID(),
        expectedRevision: 0,
        context: 'MODERATION_NOTICES',
        module: 'LINKS',
        enabled: true,
      }),
    }),
  );
  assert.equal(group.contexts[1].partial, true);
  assert.deepEqual(
    group.contexts[1].modules.filter((item) => item.enabled).map((item) => item.module),
    ['LINKS'],
  );
  const merged = mergeMarketplaceButtonPolicy(
    { ...group, caption: 'old', captionRevision: 0 },
    { ...group, revision: 0 },
  );
  assert.equal(merged.caption, 'Реклама здесь');
  assert.equal(merged.revision, 1);
});
