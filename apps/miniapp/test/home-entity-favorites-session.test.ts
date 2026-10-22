import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ManagedEntityFavoriteType,
  ManagedEntityNetworkCompositionChange,
} from '@maxim/contracts';
import type { ApiTransport } from '../src/lib/api/transport';
import { ApiRequestError } from '../src/lib/api-request-error';
import {
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TYPES,
} from '../src/lib/home-entity-favorites';
import { HomeEntityFavoritesSession } from '../src/lib/home-entity-favorites-session';
import { ManagedEntityNetworkCompositionDraft } from '../src/lib/managed-entity-network-composition-draft';

type Category = ManagedEntityFavoriteType | null;
function fixture() {
  let version = 1;
  let labelRevision = 1;
  let labels = { ...HOME_ENTITY_FAVORITE_LABELS };
  const members = new Map<string, Category>([
    ['a', 'important'],
    ['b', 'watch'],
  ]);
  const writes: { path: string; options: Parameters<ApiTransport['request']>[1] }[] = [];
  let rejectReads = false;
  let rejectWrites = false;
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(path, options) {
      if (options?.method === 'PUT') {
        writes.push({ path, options });
        if (rejectWrites)
          throw new ApiRequestError(
            409,
            '{"code":"MANAGED_ENTITY_NETWORK_COMPOSITION_CONFLICT"}',
            'conflict',
          );
        const body = JSON.parse(options.body as string);
        if (path.endsWith('/favorite-labels')) {
          labels = { ...HOME_ENTITY_FAVORITE_LABELS, ...body.labels };
          labelRevision += 1;
          return { initialized: true, labels, revision: labelRevision };
        }
        if (path.endsWith('/composition')) {
          for (const change of body.changes as ManagedEntityNetworkCompositionChange[])
            members.set(change.entityId, change.favoriteType);
          version += 1;
          return { entityType: 'chat', changes: body.changes };
        }
        const entityId = path.split('/').at(-2)!;
        members.set(entityId, body.favoriteTypes[0] ?? null);
        version += 1;
        return { entityType: 'chat', entityId, favoriteTypes: body.favoriteTypes };
      }
      if (rejectReads) throw new Error('offline');
      if (path.endsWith('/favorite-labels'))
        return { initialized: true, labels, revision: labelRevision };
      if (path.includes('/entities?')) {
        const query = new URL(path, 'http://test').searchParams;
        const offset = Number(query.get('cursor') ?? 0);
        const rows = [...members].filter(([, category]) => category !== null);
        return {
          entityType: 'chat',
          compositionVersion: `v${version}`,
          items: rows.slice(offset, offset + 100).map(([id, favoriteType]) => ({
            id,
            entityType: 'chat',
            title: id,
            avatarUrl: null,
            favoriteType,
          })),
          nextCursor: offset + 100 < rows.length ? String(offset + 100) : null,
        };
      }
      return {
        entityType: path.endsWith('/channel') ? 'channel' : 'chat',
        compositionVersion: `v${version}`,
        labelsRevision: labelRevision,
        items: HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => ({
          favoriteType,
          label: labels[favoriteType],
          entityCount: [...members.values()].filter((value) => value === favoriteType).length,
          compositionVersion: `category-${favoriteType}-${version}`,
        })),
      };
    },
  };
  return {
    api,
    members,
    writes,
    advance: () => {
      version += 1;
    },
    rejectReads: (value: boolean) => {
      rejectReads = value;
    },
    rejectWrites: (value: boolean) => {
      rejectWrites = value;
    },
  };
}

test('same confirmed type version is stable; changed version invalidates only its entity type', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshCatalogue('chat');
  await session.refreshAssignments('chat');
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 0);
  await session.refreshCatalogue('chat');
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 0);
  f.advance();
  await session.refreshCatalogue('chat');
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 1);
  assert.equal(session.getSnapshot().byType.chat.assignmentsComplete, false);
  await session.refreshAssignments('chat');
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 1);
  assert.equal(session.getSnapshot().byType.channel.compositionEpoch, 0);
  assert.equal(
    session.getSnapshot().byType.chat.catalogue?.items[0]?.compositionVersion,
    'category-important-2',
  );
});

test('acknowledged save survives failed refresh and never replays a mutation', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshAssignments('chat');
  f.rejectReads(true);
  const result = await session.setFavorite({
    entityType: 'chat',
    entityId: 'a',
    expectedFavoriteType: 'important',
    favoriteType: 'watch',
  });
  assert.equal(result.refresh, 'pending');
  assert.deepEqual(session.getSnapshot().assignments.chat.watch, ['a', 'b']);
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].options?.retryMutationOnTransportError, false);
  f.rejectReads(false);
  await session.refreshAssignments('chat');
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 1);
});

test('full assignment pagination has no 500-member ceiling; partial home data cannot replace it', async () => {
  const f = fixture();
  for (let i = 0; i < 641; i += 1) f.members.set(`n${i}`, 'important');
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshAssignments('chat');
  assert.equal(session.getSnapshot().assignments.chat.important.length, 642);
  session.reconcileLoadedEntities({ chats: [{ id: 'a', favoriteTypes: ['watch'] }] as never });
  assert.equal(session.getSnapshot().assignments.chat.important.length, 642);
  assert.equal(session.getSnapshot().byType.chat.assignmentsComplete, true);
  f.advance();
  await session.refreshCatalogue('chat');
  assert.equal(session.getSnapshot().byType.chat.assignmentsComplete, false);
  session.reconcileLoadedEntities({ chats: [{ id: 'a', favoriteTypes: ['watch'] }] as never });
  assert.equal(session.getSnapshot().assignments.chat.important.length, 642);
});

test('rename response is global and a late catalogue cannot replace its newer revision', async () => {
  const f = fixture();
  let release!: () => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  const api: ApiTransport = {
    ...f.api,
    async request(path, options) {
      const response = await f.api.request(path, options);
      if (path.endsWith('/networks/chat')) {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return response;
    },
  };
  const session = new HomeEntityFavoritesSession(api, 'actor');
  await session.refreshLabels();
  const oldCatalogue = session.refreshCatalogue('chat');
  await waiting;
  await session.saveLabels({ baseLabels: {}, draftLabels: { important: 'Редакция' } });
  assert.equal(session.getSnapshot().labels.resolved.important, 'Редакция');
  assert.equal(session.getSnapshot().labels.revision, 2);
  assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 0);
  release();
  await oldCatalogue;
  assert.equal(session.getSnapshot().labels.resolved.important, 'Редакция');
});

test('disposed credential session rejects late acknowledgement and never publishes into another binding', async () => {
  let release!: (value: unknown) => void;
  let started!: () => void;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  const api: ApiTransport = {
    requestKeepalive() {},
    request: () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  };
  const old = new HomeEntityFavoritesSession(api, 'same-actor');
  const next = new HomeEntityFavoritesSession(fixture().api, 'same-actor');
  const pending = old.setFavorite({
    entityType: 'chat',
    entityId: 'a',
    expectedFavoriteType: null,
    favoriteType: 'watch',
  });
  await requested;
  old.dispose();
  release({ entityType: 'chat', entityId: 'a', favoriteTypes: ['watch'] });
  await assert.rejects(pending);
  assert.deepEqual(next.getSnapshot().assignments.chat.watch, []);
  assert.equal(old.getSnapshot().byType.chat.compositionEpoch, 0);
});

test('disposing during lazy write loading prevents every request for the old credential binding', async () => {
  for (const action of ['favorite', 'composition', 'labels'] as const) {
    const f = fixture();
    const session = new HomeEntityFavoritesSession(f.api, 'old-actor');
    let requests = 0;
    const request = f.api.request;
    f.api.request = (...args) => {
      requests += 1;
      return request(...args);
    };
    const change = {
      entityType: 'chat' as const,
      entityId: 'a',
      expectedFavoriteType: 'important' as const,
      favoriteType: 'watch' as const,
    };
    const pending =
      action === 'favorite'
        ? session.setFavorite(change)
        : action === 'composition'
          ? session.commitComposition({ entityType: 'chat', changes: [change] })
          : session.saveLabels({ baseLabels: {}, draftLabels: { important: 'Редакция' } });
    session.dispose();
    await assert.rejects(pending);
    assert.equal(requests, 0, action);
    assert.equal(f.writes.length, 0, action);
    assert.equal(session.getSnapshot().byType.chat.compositionEpoch, 0, action);
  }
});

test('lazy mutation loading retains the synchronous type lock and original write preconditions', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  const change = {
    entityType: 'chat' as const,
    entityId: 'a',
    expectedFavoriteType: 'important' as Category,
    favoriteType: 'watch' as Category,
  };
  const pending = session.setFavorite(change);
  assert.equal(f.writes.length, 0);
  const overlapping = session.commitComposition({ entityType: 'chat', changes: [change] });
  change.entityId = 'another';
  change.expectedFavoriteType = null;
  change.favoriteType = 'service';
  await assert.rejects(overlapping, /Дождитесь сохранения состава/u);
  await pending;
  assert.equal(f.writes.length, 1);
  assert.deepEqual(JSON.parse(f.writes[0].options?.body as string), {
    favoriteTypes: ['watch'],
    expectedFavoriteType: 'important',
  });
  assert.match(f.writes[0].path, /\/a\/favorites$/u);
});

test('old assignment read cannot overwrite an acknowledged mutation', async () => {
  const f = fixture();
  let release!: (value: unknown) => void;
  let first = true;
  const api: ApiTransport = {
    ...f.api,
    request(path, options) {
      if (first && path.includes('/entities?')) {
        first = false;
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      return f.api.request(path, options);
    },
  };
  const session = new HomeEntityFavoritesSession(api, 'actor');
  const oldRead = session.refreshAssignments('chat');
  await session.setFavorite({
    entityType: 'chat',
    entityId: 'a',
    expectedFavoriteType: 'important',
    favoriteType: 'watch',
  });
  release({ entityType: 'chat', compositionVersion: 'old', items: [], nextCursor: null });
  await assert.rejects(oldRead);
  assert.deepEqual(session.getSnapshot().assignments.chat.watch, ['a', 'b']);
  assert.equal(session.getSnapshot().byType.chat.typeCompositionVersion, 'v2');
});

test('composition draft retains original null precondition across toggles and commits once', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  const draft = new ManagedEntityNetworkCompositionDraft(session, {
    entityType: 'chat',
    favoriteType: 'important',
  });
  draft.stage({ id: 'new', favoriteType: null }, 'important');
  draft.stage({ id: 'new', favoriteType: 'important' }, 'watch');
  assert.equal(draft.getSnapshot().changes[0].expectedFavoriteType, null);
  const result = await draft.save();
  assert.equal(result?.refresh, 'complete');
  assert.equal(f.writes.length, 1);
  assert.equal(draft.getSnapshot().dirty, false);
});

test('conflict retains desired draft, requires a confirmed read plus explicit review and separate save', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshAssignments('chat');
  const draft = new ManagedEntityNetworkCompositionDraft(session, {
    entityType: 'chat',
    favoriteType: 'important',
  });
  draft.stage({ id: 'a', favoriteType: 'important' }, 'watch');
  f.rejectWrites(true);
  f.rejectReads(true);
  await assert.rejects(draft.save());
  assert.equal(draft.getSnapshot().phase, 'review-required');
  assert.equal(draft.getSnapshot().count, 1);
  assert.throws(() => draft.rebaseAfterReview());
  await assert.rejects(draft.save());
  assert.equal(f.writes.length, 1);
  f.rejectReads(false);
  f.rejectWrites(false);
  f.members.set('a', 'service');
  f.advance();
  await session.refreshCatalogue('chat');
  await session.refreshAssignments('chat');
  draft.rebaseAfterReview();
  assert.equal(f.writes.length, 1);
  assert.deepEqual(draft.getSnapshot().changes, [
    { entityId: 'a', expectedFavoriteType: 'service', favoriteType: 'watch' },
  ]);
  await draft.save();
  assert.equal(f.writes.length, 2);
});

test('large composition drafts retain remaining choices and save at most 500 per explicit action', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  const draft = new ManagedEntityNetworkCompositionDraft(session, {
    entityType: 'chat',
    favoriteType: 'important',
  });
  for (let i = 0; i < 500; i += 1) draft.stage({ id: String(i), favoriteType: null }, 'important');
  draft.stage({ id: '501', favoriteType: null }, 'important');
  draft.stage({ id: '1', favoriteType: null }, null);
  assert.equal(draft.getSnapshot().count, 500);
  draft.stage({ id: '502', favoriteType: null }, 'important');
  await draft.save();
  assert.equal(f.writes.length, 1);
  assert.equal(JSON.parse(f.writes[0].options?.body as string).changes.length, 500);
  assert.deepEqual(draft.getSnapshot().changes, [
    { entityId: '502', expectedFavoriteType: null, favoriteType: 'important' },
  ]);
  f.rejectWrites(true);
  await assert.rejects(draft.save());
  assert.equal(draft.getSnapshot().count, 1);
  assert.equal(draft.getSnapshot().phase, 'review-required');
  assert.equal(f.members.get('502'), undefined);
});

test('rename preserves a dirty composition draft; a newly observed membership version requires review', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshAssignments('chat');
  const draft = new ManagedEntityNetworkCompositionDraft(session, {
    entityType: 'chat',
    favoriteType: 'important',
  });
  draft.stage({ id: 'a', favoriteType: 'important' }, 'watch');
  await session.saveLabels({ baseLabels: {}, draftLabels: { important: 'Редакция' } });
  assert.equal(draft.getSnapshot().phase, 'editing');
  assert.equal(draft.getSnapshot().count, 1);
  f.members.set('a', 'service');
  f.advance();
  await session.refreshCatalogue('chat');
  assert.equal(draft.getSnapshot().phase, 'review-required');
  assert.deepEqual(draft.getSnapshot().changes, [
    { entityId: 'a', expectedFavoriteType: 'important', favoriteType: 'watch' },
  ]);
});

test('saved draft clears even when refresh fails and leaves pending state after a successful read recovery', async () => {
  const f = fixture();
  const session = new HomeEntityFavoritesSession(f.api, 'actor');
  await session.refreshAssignments('chat');
  const draft = new ManagedEntityNetworkCompositionDraft(session, {
    entityType: 'chat',
    favoriteType: 'important',
  });
  draft.stage({ id: 'a', favoriteType: 'important' }, 'watch');
  f.rejectReads(true);
  const result = await draft.save();
  assert.equal(result?.refresh, 'pending');
  assert.equal(draft.getSnapshot().dirty, false);
  assert.equal(draft.getSnapshot().phase, 'saved-refresh-pending');
  f.rejectReads(false);
  await session.refreshCatalogue('chat');
  await session.refreshAssignments('chat');
  assert.equal(draft.getSnapshot().phase, 'editing');
  assert.equal(f.writes.length, 1);
});
