import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseEditorLinkHref } from '../src/lib/max-rich-text-link';
import { MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH } from '@maxim/contracts/channel-dialog';
import { renderSupportedMarkdownAsHtml } from '../src/lib/max-markdown';
import {
  prepareSuggestionVideo,
  readSuggestionTextFile,
  toSuggestionMediaPayload,
} from '../src/lib/channel-suggestion-media';
import {
  parseChannelSuggestionDraftEnvelope,
  buildChannelSuggestionThreadScope,
  buildChannelSuggestionDraftStorageKey,
  resolveChannelSuggestionDraftLoadState,
  MAX_STORED_SUGGESTION_VIDEO_BASE64_LENGTH,
} from '../src/features/channel-suggestions/channel-suggestion-draft-storage';

test('schema-free draft restore keeps the exact shared video size bound', () => {
  assert.equal(
    MAX_STORED_SUGGESTION_VIDEO_BASE64_LENGTH,
    MAX_CHANNEL_SUGGESTION_VIDEO_BASE64_LENGTH,
  );
});

test('prepares video and emits a video field instead of disguising it as an image', async () => {
  const video = await prepareSuggestionVideo(
    new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
  );
  assert.equal(video.type, 'video');
  assert.match(video.previewUrl!, /^data:video\/mp4;base64,/u);
  assert.deepEqual(toSuggestionMediaPayload([video]), {
    images: [],
    video: { base64: 'dmlkZW8=', mimeType: 'video/mp4', fileName: 'clip.mp4' },
  });
  assert.throws(
    () => toSuggestionMediaPayload([video, { ...video, type: 'image' }]),
    /отдельными/u,
  );
});

test('rejects unsupported or oversized video before reading its bytes', async () => {
  await assert.rejects(
    prepareSuggestionVideo(new File(['x'], 'page.html', { type: 'text/html' })),
    /MP4/u,
  );
  let read = false;
  await assert.rejects(
    prepareSuggestionVideo({
      name: 'large.mp4',
      size: 24_000_001,
      type: 'video/mp4',
      arrayBuffer: async () => {
        read = true;
        return new ArrayBuffer(0);
      },
    } as File),
    /24/u,
  );
  assert.equal(read, false);
});

test('imports text without losing the current draft and rejects binary or over-limit files', async () => {
  assert.equal(
    await readSuggestionTextFile(new File(['\uFEFF**New**\r\nline'], 'draft.md'), 'Existing', 2000),
    'Existing\n\n**New**\nline',
  );
  await assert.rejects(readSuggestionTextFile(new File(['x\0y'], 'draft.txt'), '', 2000));
  await assert.rejects(readSuggestionTextFile(new File(['long'], 'draft.txt'), 'Existing', 5));
});

test('imported Markdown cannot insert credential-bearing or unsupported editor links', () => {
  for (const href of [
    'https://user:password@example.test/',
    'http://example.test/',
    'max://other/path',
  ]) {
    assert.doesNotMatch(
      renderSupportedMarkdownAsHtml(`[Label](${href})`, {
        blockMode: 'editor',
        resolveLinkHref: parseEditorLinkHref,
      }),
      /href=/u,
    );
  }
  assert.match(
    renderSupportedMarkdownAsHtml('[Label](https://example.test/)', {
      blockMode: 'editor',
      resolveLinkHref: parseEditorLinkHref,
    }),
    /href="https:\/\/example.test\/"/u,
  );
  const editor = readFileSync(
    new URL('../src/components/max-rich-text-editor.tsx', import.meta.url),
    'utf8',
  );
  assert.equal((editor.match(/resolveLinkHref: parseEditorLinkHref/gu) ?? []).length, 2);
});

test('restores a video draft in its own profile scope and never combines it with images', async () => {
  const video = await prepareSuggestionVideo(
    new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
  );
  const scope = {
    userId: 'user-1',
    chatId: 'channel-1',
    profile: 'publisher' as const,
    threadScope: buildChannelSuggestionThreadScope('token')!,
  };
  assert.notEqual(
    buildChannelSuggestionDraftStorageKey(scope),
    buildChannelSuggestionDraftStorageKey({ ...scope, profile: 'moderation' }),
  );
  const now = Date.now();
  const envelope = {
    version: 1,
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    text: 'Caption',
    imageCount: 1,
    threadScope: scope.threadScope,
    requestIdentity: { draftRevision: 1, requestId: null, requestRevision: null },
  };
  const restored = parseChannelSuggestionDraftEnvelope(envelope, now, {
    version: 1,
    attachments: [video],
  });
  assert.equal(restored?.attachments[0]?.type, 'video');
  assert.equal(restored?.imagesNeedReselection, false);
  const mixed = parseChannelSuggestionDraftEnvelope({ ...envelope, imageCount: 2 }, now, {
    version: 1,
    attachments: [video, { ...video, type: 'image', mimeType: 'image/jpeg' }],
  });
  assert.equal(mixed?.attachments.length, 0);
  assert.equal(mixed?.imagesNeedReselection, true);
});

test('a newer page-close text fallback keeps the exact previously stored video', async () => {
  const video = await prepareSuggestionVideo(
    new File(['video'], 'clip.mp4', { type: 'video/mp4' }),
  );
  const now = Date.now();
  const threadScope = buildChannelSuggestionThreadScope('token')!;
  const indexedEnvelope = {
    version: 1,
    mediaKey: 'suggestion-media_same-key',
    savedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    text: 'Old caption',
    imageCount: 1,
    threadScope,
    requestIdentity: { draftRevision: 1, requestId: null, requestRevision: null },
  };
  const localEnvelope = {
    ...indexedEnvelope,
    savedAt: new Date(now).toISOString(),
    text: 'Latest caption',
    requestIdentity: { draftRevision: 2, requestId: null, requestRevision: null },
  };
  const input = {
    indexedEnvelope,
    indexedMedia: { version: 1, mediaKey: indexedEnvelope.mediaKey, attachments: [video] },
    localEnvelope,
    threadScope,
    nowMs: now,
  };
  const restored = resolveChannelSuggestionDraftLoadState(input);
  assert.equal(restored.draft?.text, 'Latest caption');
  assert.equal(restored.draft?.attachments[0]?.type, 'video');
  assert.equal(restored.draft?.imagesNeedReselection, false);
  assert.equal(restored.discardIndexed, false);
  const changed = resolveChannelSuggestionDraftLoadState({
    ...input,
    localEnvelope: { ...localEnvelope, mediaKey: 'suggestion-media_different-key' },
  });
  assert.equal(changed.draft?.attachments.length, 0);
  assert.equal(changed.draft?.imagesNeedReselection, true);
});
