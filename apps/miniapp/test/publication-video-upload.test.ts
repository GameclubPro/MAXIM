import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadPublicationVideo, uploadVideoBinary } from '../src/lib/api/publication-video-upload';
import type { ApiTransport } from '../src/lib/api/transport';

test('uploads a 36 MB file directly and sends only metadata to the API', async () => {
  const file = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  Object.defineProperty(file, 'size', { value: 36_000_000 });
  const calls: Array<{ path: string; body?: BodyInit | null }> = [];
  let binarySent = false;
  let uploadId = '';
  const asset = {
    id: 'asset',
    type: 'video',
    mimeType: 'video/mp4',
    fileName: 'clip.mp4',
    sizeBytes: file.size,
  };
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(path, init) {
      calls.push({ path, body: init?.body });
      if (path.endsWith('/complete')) {
        assert.equal(binarySent, true);
        return { status: 'READY', uploadId, asset };
      }
      const metadata = JSON.parse(String(init?.body));
      uploadId = metadata.requestId;
      assert.equal(metadata.sizeBytes, 36_000_000);
      assert.equal('base64' in metadata, false);
      return {
        status: 'UPLOADING',
        uploadId,
        url: 'https://test.okcdn.ru/upload',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  };
  assert.deepEqual(
    await uploadPublicationVideo(
      api,
      file,
      new AbortController().signal,
      () => {},
      async (blob, url) => {
        assert.equal(blob, file);
        assert.equal(url, 'https://test.okcdn.ru/upload');
        binarySent = true;
      },
    ),
    asset,
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => String(call.body ?? '').length < 512));
});

test('does not complete or attach a failed binary upload', async () => {
  let calls = 0;
  const api: ApiTransport = {
    requestKeepalive() {},
    async request(_path, init) {
      calls += 1;
      return {
        status: 'UPLOADING',
        uploadId: JSON.parse(String(init?.body)).requestId,
        url: 'https://test.okcdn.ru/upload',
        expiresAt: new Date().toISOString(),
      };
    },
  };
  await assert.rejects(
    uploadPublicationVideo(
      api,
      new File(['video'], 'clip.mp4'),
      new AbortController().signal,
      () => {},
      async () => {
        throw new Error('offline');
      },
    ),
    /offline/u,
  );
  assert.equal(calls, 1);
});

test('never sends a file to an untrusted, credential-bearing, or cleartext upload URL', async () => {
  for (const url of [
    'http://test.okcdn.ru/upload',
    'https://okcdn.ru.evil.example/upload',
    'https://user:password@test.okcdn.ru/upload',
    'https://test.okcdn.ru:8080/upload',
  ]) {
    await assert.rejects(
      uploadVideoBinary(
        new File(['video'], 'clip.mp4'),
        url,
        new AbortController().signal,
        () => {},
      ),
      /Адрес загрузки/u,
    );
  }
});
