import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  getMessageRetention,
  updateMessageRetention,
} from '../src/lib/api/message-retention-client';
import { PREVIEW_CHAT_ID } from '../src/lib/design-preview';

test('message retention starts off and persists both modes independently', async () => {
  const api = createPreviewApiTransport();
  const initial = await getMessageRetention(api, PREVIEW_CHAT_ID);
  assert.equal(initial.enabled, false);
  assert.equal(initial.hours, 48);
  const enabled = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 24,
    expectedRevision: initial.revision,
  });
  assert.equal(enabled.status, 'running');
  const changed = await updateMessageRetention(api, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 48,
    expectedRevision: enabled.revision,
  });
  assert.equal(changed.hours, 48);
  assert.equal(changed.enabledAt, enabled.enabledAt);
  await assert.rejects(
    updateMessageRetention(api, PREVIEW_CHAT_ID, {
      enabled: false,
      hours: 24,
      expectedRevision: 0,
    }),
  );
  assert.equal((await getMessageRetention(api, PREVIEW_CHAT_ID)).enabled, true);
});

test('retention preview is scoped to one transport and chat', async () => {
  const first = createPreviewApiTransport();
  await updateMessageRetention(first, PREVIEW_CHAT_ID, {
    enabled: true,
    hours: 24,
    expectedRevision: 0,
  });
  assert.equal(
    (await getMessageRetention(createPreviewApiTransport(), PREVIEW_CHAT_ID)).enabled,
    false,
  );
  await assert.rejects(getMessageRetention(first, 'missing-chat'));
});
