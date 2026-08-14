import type { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { PhotoDownloadHttpError, SecurePhotoDownloader } from './secure-photo-downloader';

type MockResponse = {
  statusCode: number;
  headers: Record<string, string>;
  chunks?: Buffer[];
  chunkDelayMs?: number;
  requestError?: Error;
  waitForAbort?: boolean;
};

class TestDownloader extends SecurePhotoDownloader {
  readonly requested: Array<{ hostname: string; address: string; timeoutMs: number }> = [];
  readonly resolvedHostnames: string[] = [];
  readonly abortedAddresses: string[] = [];
  readonly closes: jest.Mock[] = [];
  resolvedAddresses = [{ address: '93.184.216.34', family: 4 as const }];
  resolvedAddressBatches: Array<Array<{ address: string; family: 4 | 6 }>> = [];

  constructor(
    config: Record<string, string>,
    private readonly responses: MockResponse[],
  ) {
    super({ get: (key: string) => config[key] } as ConfigService);
  }

  protected override async resolveHost(hostname: string) {
    this.resolvedHostnames.push(hostname);
    return this.resolvedAddressBatches.shift() ?? this.resolvedAddresses;
  }

  protected override async request(
    url: URL,
    resolved: { address: string; family: 4 | 6 },
    timeoutMs: number,
    signal?: AbortSignal,
  ) {
    this.requested.push({ hostname: url.hostname, address: resolved.address, timeoutMs });
    const response = this.responses.shift();
    if (!response) {
      throw new Error('Missing mock response');
    }
    if (response.requestError) {
      throw response.requestError;
    }
    if (response.waitForAbort) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          this.abortedAddresses.push(resolved.address);
          reject(new Error('Mock request was aborted'));
        };
        if (!signal) {
          reject(new Error('Mock request is missing its abort signal'));
          return;
        }
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    const close = jest.fn();
    this.closes.push(close);
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: (async function* () {
        for (const chunk of response.chunks ?? []) {
          if (response.chunkDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, response.chunkDelayMs));
          }
          yield chunk;
        }
      })(),
      close,
    };
  }
}

async function createPng(width = 20, height = 10): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 30, g: 120, b: 210 },
    },
  })
    .png()
    .toBuffer();
}

describe('SecurePhotoDownloader', () => {
  const invalidResponseCases: Array<{
    name: string;
    response: MockResponse;
    error: string;
  }> = [
    {
      name: 'an invalid redirect location',
      response: { statusCode: 302, headers: {} },
      error: 'redirect location',
    },
    {
      name: 'an invalid content type',
      response: { statusCode: 200, headers: { 'content-type': 'text/html' } },
      error: 'content type',
    },
    {
      name: 'an invalid content length',
      response: {
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-length': 'invalid' },
      },
      error: 'content length',
    },
  ];

  it.each(['i.oneme.ru', 'fd.oneme.ru'])(
    'pins the validated public address for the default MAX CDN host %s',
    async (hostname) => {
      const png = await createPng();
      const downloader = new TestDownloader({}, [
        {
          statusCode: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(png.length) },
          chunks: [png],
        },
      ]);

      await expect(
        downloader.download(`https://${hostname}/i?opaque=token`),
      ).resolves.toMatchObject({
        format: 'png',
      });
      expect(downloader.requested).toEqual([
        {
          hostname,
          address: '93.184.216.34',
          timeoutMs: expect.any(Number),
        },
      ]);
      expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'http://i.oneme.ru/image',
    'https://user:password@i.oneme.ru/image',
    'https://i.oneme.ru:8443/image',
    'https://evil.fd.oneme.ru/image',
    'https://evil.example/image',
  ])('rejects a URL outside the HTTPS allowlist before requesting it: %s', async (url) => {
    const downloader = new TestDownloader({}, []);

    await expect(downloader.download(url)).rejects.toThrow('not permitted');
    expect(downloader.requested).toHaveLength(0);
  });

  it('allows deployments to narrow the default CDN host set explicitly', async () => {
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_ALLOWED_HOSTS: 'i.oneme.ru' }, []);

    await expect(downloader.download('https://fd.oneme.ru/image')).rejects.toThrow('not permitted');
    expect(downloader.requested).toHaveLength(0);
  });

  it('rejects if any DNS answer is private', async () => {
    const downloader = new TestDownloader({}, []);
    downloader.resolvedAddresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ];

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow(
      'public addresses',
    );
    expect(downloader.requested).toHaveLength(0);
  });

  it('revalidates the redirect target against the allowlist', async () => {
    const downloader = new TestDownloader({}, [
      { statusCode: 302, headers: { location: 'https://evil.example/private' } },
    ]);

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow('not permitted');
    expect(downloader.requested).toHaveLength(1);
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it('rejects an allowed redirect if its fresh DNS resolution becomes private', async () => {
    const downloader = new TestDownloader({}, [
      { statusCode: 302, headers: { location: 'https://i.oneme.ru/final' } },
    ]);
    downloader.resolvedAddressBatches = [
      [{ address: '93.184.216.34', family: 4 }],
      [{ address: '127.0.0.1', family: 4 }],
    ];

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow(
      'public addresses',
    );
    expect(downloader.resolvedHostnames).toEqual(['i.oneme.ru', 'i.oneme.ru']);
    expect(downloader.requested).toHaveLength(1);
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it.each(invalidResponseCases)(
    'closes the response when $name is rejected',
    async ({ response, error }) => {
      const downloader = new TestDownloader({}, [response]);

      await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow(error);
      expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
    },
  );

  it('preserves an unsuccessful HTTP status for caller retry classification', async () => {
    const downloader = new TestDownloader({}, [{ statusCode: 503, headers: {} }]);

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toEqual(
      expect.objectContaining<Partial<PhotoDownloadHttpError>>({
        name: 'PhotoDownloadHttpError',
        statusCode: 503,
      }),
    );
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it('falls back to another prevalidated address without resolving the hostname again', async () => {
    const png = await createPng();
    const downloader = new TestDownloader({}, [
      {
        statusCode: 0,
        headers: {},
        requestError: new Error('First address is unreachable'),
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [png],
      },
    ]);
    downloader.resolvedAddresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];

    await expect(downloader.download('https://i.oneme.ru/image')).resolves.toMatchObject({
      format: 'png',
    });
    expect(downloader.resolvedHostnames).toEqual(['i.oneme.ru']);
    expect(downloader.requested.map(({ address }) => address)).toEqual([
      '93.184.216.34',
      '93.184.216.35',
    ]);
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it('aborts a stalled address within its share of the deadline before falling back', async () => {
    const png = await createPng();
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: '1000' }, [
      {
        statusCode: 0,
        headers: {},
        waitForAbort: true,
      },
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [png],
      },
    ]);
    downloader.resolvedAddresses = [
      { address: '93.184.216.34', family: 4 },
      { address: '93.184.216.35', family: 4 },
    ];

    await expect(downloader.download('https://i.oneme.ru/image')).resolves.toMatchObject({
      format: 'png',
    });
    expect(downloader.abortedAddresses).toEqual(['93.184.216.34']);
    expect(downloader.requested.map(({ address }) => address)).toEqual([
      '93.184.216.34',
      '93.184.216.35',
    ]);
  });

  it('enforces the streamed byte limit without trusting content-length', async () => {
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_MAX_BYTES: '8' }, [
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [Buffer.alloc(5), Buffer.alloc(5)],
      },
    ]);

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow('byte limit');
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it('rejects non-image bytes even when the server claims an image content type', async () => {
    const downloader = new TestDownloader({}, [
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [Buffer.from('<html>not an image</html>')],
      },
    ]);

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow(
      'image signature',
    );
  });

  it('applies the absolute deadline while the response body is streaming', async () => {
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: '20' }, [
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [Buffer.from('slow')],
        chunkDelayMs: 50,
      },
    ]);

    await expect(downloader.download('https://i.oneme.ru/image')).rejects.toThrow(
      'Photo download timed out',
    );
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
  });

  it('uses a caller absolute deadline as a stricter ceiling than its configured timeout', async () => {
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: '1000' }, [
      {
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        chunks: [Buffer.from('slow')],
        chunkDelayMs: 50,
      },
    ]);

    await expect(
      downloader.download('https://i.oneme.ru/image', { deadlineAtMs: Date.now() + 20 }),
    ).rejects.toThrow('Photo download timed out');
    expect(downloader.closes[0]).toHaveBeenCalledTimes(1);
    expect(downloader.requested[0]?.timeoutMs).toBeLessThanOrEqual(20);
  });

  it('rejects an invalid caller deadline before acquiring a slot', async () => {
    const downloader = new TestDownloader({}, []);

    await expect(
      downloader.download('https://i.oneme.ru/image', { deadlineAtMs: Number.NaN }),
    ).rejects.toThrow('deadline is invalid');
    expect(downloader.requested).toHaveLength(0);
    expect((downloader as any).activeDownloads).toBe(0);
  });

  it('includes concurrency-slot waiting in the same absolute deadline', async () => {
    const responses = Array.from({ length: 5 }, () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      chunks: [Buffer.from('slow')],
      chunkDelayMs: 60,
    }));
    const downloader = new TestDownloader({ PHOTO_DUPLICATE_DOWNLOAD_TIMEOUT_MS: '25' }, responses);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, index) =>
        downloader.download(`https://i.oneme.ru/image-${index}`),
      ),
    );

    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect((downloader as any).waiters).toHaveLength(0);
    expect((downloader as any).activeDownloads).toBe(0);
  });

  it('never oversubscribes when a new caller takes a released slot before a waiter resumes', async () => {
    const downloader = new TestDownloader({}, []);
    const acquireSlot = (deadlineAtMs: number) =>
      (downloader as any).acquireSlot(deadlineAtMs) as Promise<() => void>;
    const deadlineAtMs = Date.now() + 10_000;
    const initialReleases = await Promise.all(
      Array.from({ length: 4 }, () => acquireSlot(deadlineAtMs)),
    );
    const waitingReleasePromise = acquireSlot(deadlineAtMs);

    await Promise.resolve();
    expect((downloader as any).waiters).toHaveLength(1);

    const competingReleasePromise = Promise.resolve().then(() => acquireSlot(deadlineAtMs));
    initialReleases[0]!();
    const competingRelease = await competingReleasePromise;

    expect((downloader as any).activeDownloads).toBe(4);
    expect((downloader as any).waiters).toHaveLength(1);

    competingRelease();
    const waitingRelease = await waitingReleasePromise;
    expect((downloader as any).activeDownloads).toBe(4);

    waitingRelease();
    for (const release of initialReleases.slice(1)) {
      release();
    }
    expect((downloader as any).activeDownloads).toBe(0);
    expect((downloader as any).waiters).toHaveLength(0);
  });
});
