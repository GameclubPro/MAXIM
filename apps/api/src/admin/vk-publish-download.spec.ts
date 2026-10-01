import { VkPublishService } from './vk-publish.service';
import { VK_IMAGE_FETCH_TIMEOUT_MS, VK_IMAGE_MAX_BYTES } from './vk-parsing-media-cache.service';
import { MAX_VIDEO_UPLOAD_MAX_BYTES } from '../max/max-video-upload.constants';

type DownloadHarness = {
  downloadImage(url: string, index: number): Promise<{ buffer: Buffer; fileName: string }>;
  downloadVideo(url: string): Promise<{ buffer: Buffer; fileName: string; mimeType: string }>;
};

describe('VK bounded media downloads', () => {
  const originalFetch = global.fetch;
  const service = Object.create(VkPublishService.prototype) as DownloadHarness;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it.each([undefined, '1'])('cancels an oversized image with Content-Length %s', async (length) => {
    const cancel = jest.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(VK_IMAGE_MAX_BYTES + 1));
        },
        cancel,
      }),
      {
        headers: { 'content-type': 'image/jpeg', ...(length ? { 'content-length': length } : {}) },
      },
    );
    global.fetch = jest.fn().mockResolvedValue(response);
    await expect(service.downloadImage('https://vk.example/photo.jpg', 0)).rejects.toThrow(
      'Фото из VK слишком большое.',
    );
    expect(cancel).toHaveBeenCalled();
    expect(response.body!.locked).toBe(false);
  });

  it('accepts a streamed image with a false short header without truncation', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { 'content-type': 'image/jpeg', 'content-length': '1' },
      }),
    );
    await expect(service.downloadImage('https://vk.example/photo.jpg', 1)).resolves.toMatchObject({
      buffer: Buffer.from([1, 2, 3]),
      fileName: 'photo.jpg',
    });
  });

  it('keeps video byte equality checking and content-type fallback', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        }),
      );
    await expect(service.downloadVideo('https://vk.example/clip.mp4')).resolves.toMatchObject({
      buffer: Buffer.from([1, 2, 3, 4]),
      mimeType: 'video/mp4',
    });
    await expect(service.downloadVideo('https://vk.example/clip.mp4')).rejects.toThrow(
      'Размер скачанного видео VK не совпал с Content-Length.',
    );
  });

  it('cancels a declared oversized video and metadata rejection before body loading', async () => {
    const cancel = jest.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: {
        'content-type': 'video/mp4',
        'content-length': String(MAX_VIDEO_UPLOAD_MAX_BYTES + 1),
      },
    });
    global.fetch = jest.fn().mockResolvedValue(response);
    await expect(service.downloadVideo('https://vk.example/clip.mp4')).rejects.toThrow(
      'Видео из VK слишком большое.',
    );
    expect(cancel).toHaveBeenCalled();
  });

  it('bounds a stalled image read by its existing fetch deadline', async () => {
    jest.useFakeTimers();
    const cancel = jest.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-type': 'image/jpeg' },
    });
    global.fetch = jest.fn().mockResolvedValue(response);
    const result = service.downloadImage('https://vk.example/photo.jpg', 0);
    const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(VK_IMAGE_FETCH_TIMEOUT_MS);
    await rejection;
    expect(cancel).toHaveBeenCalled();
    expect(response.body!.locked).toBe(false);
  });
});
