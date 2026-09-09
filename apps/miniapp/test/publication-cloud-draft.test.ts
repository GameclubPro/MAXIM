import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicationDraftAutosave } from '../src/features/publications/publication-draft-autosave';
import {
  draftFromServer,
  serverDraftRequest,
} from '../src/features/publications/publication-cloud-draft-model';
import {
  createEmptyPublicationDraft,
  type PublicationDraft,
} from '../src/features/publications/publication-model';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  saveServerPublicationDraft,
  findServerPublicationDraft,
  getServerPublicationDraft,
  deleteServerPublicationDraft,
  getPublicationAsset,
} from '../src/lib/api/publication-drafts-client';
import { listPublications, updatePublication } from '../src/lib/api/publication-client';
import { buildUpdatePublicationRequest } from '../src/features/publications/publication-model';
import { parsePublicationDraftEnvelope } from '../src/features/publications/publication-draft-storage';

const initial = (): PublicationDraft => ({
  ...createEmptyPublicationDraft(),
  text: 'Первый текст',
});
function setup(draft = initial()) {
  const api = createPreviewApiTransport();
  const writes: Parameters<typeof saveServerPublicationDraft>[] = [];
  const changes: PublicationDraft[] = [];
  const dependencies = {
    save: async (id: string | null, request: Parameters<typeof saveServerPublicationDraft>[2]) => {
      writes.push([api, id, request]);
      return saveServerPublicationDraft(api, id, request);
    },
    get: (id: string) => getServerPublicationDraft(api, id),
    find: (id: string) => findServerPublicationDraft(api, id),
    persist: async (_draft: PublicationDraft) => undefined,
    changed: (value: PublicationDraft) => {
      changes.push(value);
    },
    stateChanged: () => undefined,
    canSave: () => true,
  };
  return {
    api,
    writes,
    dependencies,
    changes,
    make: () => new PublicationDraftAutosave(draft, dependencies),
  };
}

test('drafts persist incomplete authoring state without creating occurrences', async () => {
  const { api } = setup();
  const draft = {
    ...initial(),
    text: '',
    timingMode: 'once' as const,
    onceTime: '',
    buttons: [{ text: 'Кнопка', url: '' }],
    buttonEnabled: true,
  };
  const saved = await saveServerPublicationDraft(
    api,
    null,
    serverDraftRequest(draft, 'draft-request-1'),
  );
  assert.equal(saved.publication.lifecycle, 'DRAFT');
  assert.deepEqual(saved.publication.targets, []);
  assert.deepEqual(saved.publication.occurrences, []);
  assert.deepEqual(draftFromServer(saved).buttons, draft.buttons);
  assert.equal(draftFromServer(saved).onceTime, '');
  assert.ok(
    (await listPublications(api, { view: 'drafts' })).items.some(
      (item) => item.id === saved.publication.id,
    ),
  );
});

test('autosave uploads media once, then writes references and preserves newer typing', async () => {
  const { dependencies, writes, make } = setup({
    ...initial(),
    images: [{ base64: 'aGVsbG8=', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
  });
  const originalSave = dependencies.save;
  let entered!: () => void;
  const start = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  dependencies.save = async (id, request) => {
    entered();
    await gate;
    return originalSave(id, request);
  };
  const engine = make();
  const saving = engine.flush();
  await start;
  engine.setSnapshot({ ...engine.getSnapshot(), text: 'Новый текст' });
  release();
  const result = await saving;
  assert.equal(result.text, 'Новый текст');
  assert.equal(result.images.length, 0);
  assert.equal(result.retainedAssets.length, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0][2].content.media[0].type, 'image');
  assert.equal(writes[1][2].content.media[0].type, 'image-ref');
  assert.equal(writes[1][2].content.text, 'Новый текст');
  await engine.flush();
  assert.equal(writes.length, 2);
});

test('an uncertain write retries the exact request before saving subsequent changes', async () => {
  const { dependencies, writes, make } = setup();
  const originalSave = dependencies.save;
  let failed = false;
  dependencies.save = async (id, request) => {
    const saved = await originalSave(id, request);
    if (!failed) {
      failed = true;
      throw new Error('Нет связи');
    }
    return saved;
  };
  const engine = make();
  await assert.rejects(engine.flush());
  engine.setSnapshot({ ...engine.getSnapshot(), text: 'После обрыва' });
  const saved = await engine.flush();
  assert.deepEqual(writes[1][2], writes[0][2]);
  assert.equal(writes[2][2].content.text, 'После обрыва');
  assert.equal(saved.cloudDraft?.revision, 2);
});

test('changed media is never replaced by an old acknowledgment', async () => {
  const { dependencies, make } = setup();
  const originalSave = dependencies.save;
  const engine = make();
  let changed = false;
  dependencies.save = async (id, request) => {
    if (!changed) {
      changed = true;
      engine.setSnapshot({
        ...engine.getSnapshot(),
        images: [{ base64: 'bmV3', mimeType: 'image/png', fileName: 'new.png' }],
      });
    }
    return originalSave(id, request);
  };
  const saved = await engine.flush();
  assert.equal(saved.retainedAssets[0].fileName, 'new.png');
});

test('an acknowledgment waits for an in-progress photo batch before replacing inline media', async () => {
  const photo = { base64: 'aGVsbG8=', mimeType: 'image/jpeg', fileName: 'first.jpg' };
  const fixture = setup({ ...initial(), images: [photo] });
  const originalSave = fixture.dependencies.save;
  fixture.dependencies.save = async (id, request) => {
    fixture.dependencies.canSave = () => false;
    return originalSave(id, request);
  };
  const engine = fixture.make();
  const first = await engine.flush();
  assert.equal(first.images.length, 1);
  assert.equal(first.retainedAssets.length, 0);
  assert.equal(fixture.writes.length, 1);
  engine.setSnapshot({
    ...first,
    images: [photo, { ...photo, base64: 'bmV3', fileName: 'second.jpg' }],
  });
  fixture.dependencies.canSave = () => true;
  fixture.dependencies.save = originalSave;
  const complete = await engine.flush();
  assert.deepEqual(
    complete.retainedAssets.map((asset) => asset.fileName),
    ['first.jpg', 'second.jpg'],
  );
  assert.equal(complete.images.length, 0);
});

test('recovering an unknown create asks for a version choice and never overwrites', async () => {
  const fixture = setup({ ...initial(), cloudRequestId: 'unknown-create' });
  const saved = await saveServerPublicationDraft(
    fixture.api,
    null,
    serverDraftRequest(initial(), 'unknown-create'),
  );
  const engine = fixture.make();
  await assert.rejects(engine.flush(), { status: 409 });
  assert.equal(fixture.writes.length, 0);
  assert.equal(engine.getSnapshot().cloudDraft?.id, saved.publication.id);
  await engine.reload();
  assert.equal(engine.getSnapshot().text, saved.publication.content.text);
  await engine.flush();
  assert.equal(fixture.writes.length, 0);
});

test('another device wins by revision; save-copy preserves local text', async () => {
  const fixture = setup();
  const saved = await saveServerPublicationDraft(
    fixture.api,
    null,
    serverDraftRequest(initial(), 'first-device'),
  );
  const draft = draftFromServer(saved);
  const engine = new PublicationDraftAutosave(
    { ...draft, text: 'Моя версия' },
    fixture.dependencies,
  );
  await saveServerPublicationDraft(
    fixture.api,
    saved.publication.id,
    serverDraftRequest({ ...draft, text: 'Другая версия' }, 'other-device', 1),
  );
  await assert.rejects(engine.flush(), { status: 409 });
  const copy = await engine.saveCopy();
  assert.notEqual(copy.cloudDraft?.id, saved.publication.id);
  assert.equal(copy.text, 'Моя версия');
  assert.equal(
    (await getServerPublicationDraft(fixture.api, saved.publication.id)).publication.content.text,
    'Другая версия',
  );
});

test('a remotely deleted draft stops retries and can be saved as a separate copy', async () => {
  const fixture = setup();
  const saved = await saveServerPublicationDraft(
    fixture.api,
    null,
    serverDraftRequest(initial(), 'deleted-draft'),
  );
  const engine = new PublicationDraftAutosave(
    { ...draftFromServer(saved), text: 'Несохранённая правка' },
    fixture.dependencies,
  );
  await deleteServerPublicationDraft(fixture.api, saved.publication.id, {
    requestId: 'remote-delete',
    expectedRevision: 1,
  });
  await assert.rejects(engine.flush(), { status: 404 });
  assert.equal(fixture.writes.length, 1);
  await assert.rejects(engine.flush(), { status: 404 });
  assert.equal(fixture.writes.length, 1);
  const copy = await engine.saveCopy();
  assert.notEqual(copy.cloudDraft?.id, saved.publication.id);
  assert.equal(copy.text, 'Несохранённая правка');
});

test('local storage restores confirmed video references only with a valid cloud identity', () => {
  const draft = {
    ...initial(),
    cloudDraft: { id: 'cloud-draft', revision: 3 },
    retainedAssets: [
      {
        id: 'video-asset',
        type: 'video' as const,
        mimeType: 'video/mp4',
        fileName: 'video.mp4',
        sizeBytes: 100,
      },
    ],
  };
  assert.deepEqual(
    parsePublicationDraftEnvelope({ version: 3, draft })?.retainedAssets,
    draft.retainedAssets,
  );
  assert.deepEqual(
    parsePublicationDraftEnvelope({ version: 3, draft: { ...draft, cloudDraft: null } })
      ?.retainedAssets,
    [],
  );
});

test('draft media is readable only through its linked publication; deletion is version guarded', async () => {
  const { api } = setup();
  const saved = await saveServerPublicationDraft(
    api,
    null,
    serverDraftRequest(
      {
        ...initial(),
        images: [{ base64: 'aGVsbG8=', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
      },
      'media-request',
    ),
  );
  const blob = await getPublicationAsset(
    api,
    saved.publication.id,
    saved.publication.content.media[0].id,
  );
  assert.equal(blob.size, 5);
  await assert.rejects(getPublicationAsset(api, 'unlinked', saved.publication.content.media[0].id));
  await assert.rejects(
    deleteServerPublicationDraft(api, saved.publication.id, {
      requestId: 'delete-request',
      expectedRevision: 7,
    }),
    { status: 409 },
  );
  await deleteServerPublicationDraft(api, saved.publication.id, {
    requestId: 'delete-request',
    expectedRevision: 1,
  });
  await assert.rejects(getServerPublicationDraft(api, saved.publication.id), { status: 404 });
});

test('publishing a cloud draft updates its original identity instead of creating a second post', async () => {
  const { api } = setup();
  const saved = await saveServerPublicationDraft(
    api,
    null,
    serverDraftRequest(initial(), 'publish-draft'),
  );
  const template = (await listPublications(api, { view: 'current' })).items[0];
  const draft = draftFromServer(saved);
  draft.targets = template.targetPreviews.map((target) => ({
    id: target.chatId,
    entityType: target.entityType,
    title: target.title,
    avatarUrl: null,
    channelOverview: null,
  }));
  const published = await updatePublication(
    api,
    saved.publication.id,
    buildUpdatePublicationRequest(draft, 1, 'publish-request'),
  );
  assert.equal(published.id, saved.publication.id);
  assert.equal(published.lifecycle, 'ACTIVE');
  await assert.rejects(getServerPublicationDraft(api, saved.publication.id), { status: 404 });
});
