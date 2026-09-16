import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PUBLICATION_VIDEO_UPLOAD_BYTES } from '@maxim/contracts/publication';
import {
  MAX_PUBLICATION_VIDEO_FILE_BYTES,
  preparePublicationVideo,
} from '../src/features/publications/publication-video-preparation';

function videoFile(size: number, name = 'clip.mp4', type = 'video/mp4'): File {
  const file = new File(['video'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

test('accepts the reported 36 MB MP4 without reading or base64 encoding it', () => {
  const file = videoFile(36_000_000);
  Object.defineProperty(file, 'arrayBuffer', { value: () => assert.fail('Must not buffer video') });
  assert.deepEqual(preparePublicationVideo(file), {
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 36_000_000,
  });
});

test('enforces the 100 MB direct-upload boundary independently of inline JSON limits', () => {
  assert.equal(MAX_PUBLICATION_VIDEO_FILE_BYTES, 100_000_000);
  assert.equal(
    preparePublicationVideo(videoFile(MAX_PUBLICATION_VIDEO_FILE_BYTES)).sizeBytes,
    MAX_PUBLICATION_VIDEO_UPLOAD_BYTES,
  );
  assert.throws(
    () => preparePublicationVideo(videoFile(MAX_PUBLICATION_VIDEO_FILE_BYTES + 1)),
    /Максимум 100 МБ/u,
  );
});

test('prepares MP4 with a missing or generic native picker MIME type', async () => {
  for (const type of ['', 'application/octet-stream', 'video/mp4']) {
    const file = new File(['video'], ' CLIP.MP4 ', { type });
    assert.deepEqual(await preparePublicationVideo(file), {
      mimeType: 'video/mp4',
      fileName: 'CLIP.MP4',
      sizeBytes: 5,
    });
  }
});

test('rejects empty and unsupported files without reading them', () => {
  assert.throws(() => preparePublicationVideo(videoFile(0)), /Видео пустое/u);
  for (const [name, type] of [
    ['clip.avi', 'video/x-msvideo'],
    ['clip.mp4', 'text/plain'],
    ['clip.bin', 'application/octet-stream'],
  ]) {
    assert.throws(
      () => preparePublicationVideo(videoFile(5, name, type)),
      /Поддерживаются MP4, MOV, MKV и WebM/u,
    );
  }
});
