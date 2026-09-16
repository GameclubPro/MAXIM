import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PUBLICATION_VIDEO_BASE64_LENGTH } from '@maxim/contracts/publication';
import {
  MAX_PUBLICATION_VIDEO_FILE_BYTES,
  preparePublicationVideo,
} from '../src/features/publications/publication-video-preparation';

function videoFile(size: number, name = 'clip.mp4', type = 'video/mp4'): File {
  const file = new File(['video'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

const mustNotRead = async (): Promise<string> => {
  assert.fail('Rejected files must not be read into memory');
};

test('rejects the reported 36 MB MP4 before reading any bytes', async () => {
  await assert.rejects(
    preparePublicationVideo(videoFile(36_000_000), mustNotRead),
    /Видео не прикреплено\. Максимум 24 МБ/u,
  );
});

test('keeps the 24 MB boundary aligned with the base64 contract', async () => {
  assert.equal(MAX_PUBLICATION_VIDEO_FILE_BYTES, 24_000_000);
  const base64 = 'A'.repeat(MAX_PUBLICATION_VIDEO_BASE64_LENGTH);
  const prepared = await preparePublicationVideo(
    videoFile(MAX_PUBLICATION_VIDEO_FILE_BYTES),
    async () => base64,
  );
  assert.equal(prepared.mediaBase64.length, MAX_PUBLICATION_VIDEO_BASE64_LENGTH);
  await assert.rejects(
    preparePublicationVideo(videoFile(MAX_PUBLICATION_VIDEO_FILE_BYTES + 1), mustNotRead),
    /Максимум 24 МБ/u,
  );
});

test('prepares MP4 with a missing or generic native picker MIME type', async () => {
  for (const type of ['', 'application/octet-stream', 'video/mp4']) {
    const file = new File(['video'], ' CLIP.MP4 ', { type });
    assert.deepEqual(await preparePublicationVideo(file), {
      mediaBase64: 'dmlkZW8=',
      mediaMimeType: 'video/mp4',
      mediaFileName: 'CLIP.MP4',
    });
  }
});

test('rejects empty and unsupported files without reading them', async () => {
  await assert.rejects(preparePublicationVideo(videoFile(0), mustNotRead), /Видео пустое/u);
  for (const [name, type] of [
    ['clip.avi', 'video/x-msvideo'],
    ['clip.mp4', 'text/plain'],
    ['clip.bin', 'application/octet-stream'],
  ]) {
    await assert.rejects(
      preparePublicationVideo(videoFile(5, name, type), mustNotRead),
      /Поддерживаются MP4, MOV, MKV и WebM/u,
    );
  }
});

test('rejects empty, incomplete, and unexpectedly oversized native reads', async () => {
  for (const base64 of ['', 'AAAA']) {
    await assert.rejects(
      preparePublicationVideo(videoFile(5), async () => base64),
      /Не удалось прочитать видео полностью/u,
    );
  }
  await assert.rejects(
    preparePublicationVideo(videoFile(5), async () =>
      'A'.repeat(MAX_PUBLICATION_VIDEO_BASE64_LENGTH + 1),
    ),
    /Максимум 24 МБ/u,
  );
});

test('propagates a file read failure so the editor can show a persistent error', async () => {
  const failure = new Error('Не удалось прочитать файл.');
  await assert.rejects(
    preparePublicationVideo(videoFile(5), async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});
