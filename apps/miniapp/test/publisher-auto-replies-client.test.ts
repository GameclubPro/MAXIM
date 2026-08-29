import assert from 'node:assert/strict';
import test from 'node:test';
import { PREVIEW_CHAT_ID } from '../src/lib/design-preview';
import {
  archivePublisherAutoReply,
  createPublisherAutoReply,
  createPublisherAutoReplyAuthoringSession,
  createPublisherAutoReplyRequestId,
  getCurrentPublisherAutoReplyAuthoringSession,
  getPublisherAutoReplyAsset,
  listPublisherAutoReplies,
  updatePublisherAutoReply,
} from '../src/lib/api/publisher-auto-replies-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

const previewClock = { now: () => new Date('2026-08-29T12:00:00.000Z') };

test('publisher auto-reply preview transport supports revisioned rich-content CRUD', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const initial = await listPublisherAutoReplies(api, PREVIEW_CHAT_ID);
  assert.equal(initial.total, 1);
  assert.equal(initial.items[0]?.content.textFormat, 'markdown');

  const created = await createPublisherAutoReply(api, PREVIEW_CHAT_ID, {
    requestId: createPublisherAutoReplyRequestId(),
    phrase: '  Доставка  ',
    enabled: true,
    cooldownSeconds: 60,
    content: {
      text: '**Доставим сегодня**',
      textFormat: 'markdown',
      images: [{ type: 'image', base64: 'AAAA', mimeType: 'image/png', fileName: 'delivery.png' }],
      buttons: [{ text: 'Условия', url: 'https://max.ru/delivery', row: 0 }],
    },
  });
  assert.equal(created.phrase, 'Доставка');
  assert.equal(created.content.images.length, 1);
  assert.equal(created.content.buttons[0]?.text, 'Условия');

  const retainedAssetId = created.content.images[0]!.id;
  const updated = await updatePublisherAutoReply(api, PREVIEW_CHAT_ID, created.id, {
    requestId: createPublisherAutoReplyRequestId(),
    expectedVersion: created.version,
    enabled: false,
    content: {
      text: '_Ответ обновлён_',
      textFormat: 'markdown',
      images: [{ type: 'image-ref', assetId: retainedAssetId }],
      buttons: [{ text: 'Подробнее', url: 'https://max.ru/details', row: 0 }],
    },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.enabled, false);
  assert.equal(updated.content.images[0]?.id, retainedAssetId);
  assert.equal(updated.content.buttons[0]?.text, 'Подробнее');

  const archived = await archivePublisherAutoReply(api, PREVIEW_CHAT_ID, updated.id, {
    requestId: createPublisherAutoReplyRequestId(),
    expectedVersion: updated.version,
  });
  assert.equal(archived.archived, true);
  assert.equal((await listPublisherAutoReplies(api, PREVIEW_CHAT_ID)).total, 1);
});

test('auto-reply assets stay behind authenticated blob requests', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const rule = (await listPublisherAutoReplies(api, PREVIEW_CHAT_ID)).items[0]!;
  const blob = await getPublisherAutoReplyAsset(
    api,
    PREVIEW_CHAT_ID,
    rule.id,
    rule.content.images[0]!.id,
  );
  assert.equal(blob.type, 'image/png');
  assert.ok(blob.size > 0);
});

test('bot authoring creates a chat-scoped session and exposes its current handoff', async () => {
  const api = createPreviewApiTransport({ search: 'profile=publisher', clock: previewClock });
  const created = await createPublisherAutoReplyAuthoringSession(api, PREVIEW_CHAT_ID, {
    requestId: createPublisherAutoReplyRequestId(),
  });
  assert.equal(created.session.targetChatId, PREVIEW_CHAT_ID);
  assert.equal(created.session.state, 'awaiting_start');
  assert.match(created.botUrl, /^https:\/\/max\.ru\//u);

  const current = await getCurrentPublisherAutoReplyAuthoringSession(api, PREVIEW_CHAT_ID);
  assert.equal(current.session?.id, created.session.id);
  assert.equal(current.botUrl, created.botUrl);
});
