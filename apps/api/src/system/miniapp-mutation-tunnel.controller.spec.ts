import { BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChunkedMutationTunnelUploadStore,
  DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS,
  type ChunkedMutationTunnelUploadMetadata,
} from './chunked-mutation-tunnel-upload.store';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';

type ReplyMock = {
  header: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
};

function createReply(): ReplyMock {
  return {
    header: jest.fn(),
    status: jest.fn(),
    send: jest.fn(),
  };
}

const TEST_USER: AuthUser = {
  userId: 'user-1',
  username: null,
  displayName: 'Test User',
};

function createUploadMetadata(
  overrides: Partial<ChunkedMutationTunnelUploadMetadata> = {},
): ChunkedMutationTunnelUploadMetadata {
  return {
    method: 'POST',
    path: '/channels/channel-1/broadcast',
    contentType: 'application/json',
    authHash: 'auth-hash-1',
    authUserKey: 'user-key-1',
    chunkCount: 1,
    ...overrides,
  };
}

describe('MiniappMutationTunnelController', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('accepts enough chunks for the full 34 MiB client payload budget', () => {
    const controller = new MiniappMutationTunnelController();
    const fullBudgetChunkCount = Math.ceil((34 * 1024 * 1024) / 4_200);

    expect((controller as any).normalizeChunkCount(String(fullBudgetChunkCount))).toBe(
      fullBudgetChunkCount,
    );
    expect(() => (controller as any).normalizeChunkCount('9001')).toThrow(BadRequestException);
    controller.onModuleDestroy();
  });

  it('forwards mutation requests to the local API with the original authorization header', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const body = Buffer.from(JSON.stringify({ enabled: true }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/chats/chat-1/settings?prefetch=1',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/chats/chat-1/settings?prefetch=1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ enabled: true }),
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.header).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    expect(reply.header).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(reply.header).toHaveBeenCalledWith('Pragma', 'no-cache');
    expect(reply.header).toHaveBeenCalledWith('Vary', 'Authorization');
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('allows miniapp boot trace through the CDN mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      phase: 'index_loaded',
      sessionId: 'session-1',
      elapsedMs: 1,
    });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'POST',
        path: '/system/miniapp-boot-trace',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/system/miniapp-boot-trace',
      expect.objectContaining({
        method: 'POST',
        body: payload,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows saving a channel post signature through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ enabled: true, text: 'Читать канал' });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ enabled: true, text: 'Читать канал' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PATCH',
        path: '/channels/channel-1/post-signature',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/channel-1/post-signature',
      expect.objectContaining({
        method: 'PATCH',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows refreshing a published giveaway keyboard through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'POST',
        path: '/channels/-75313361194252/giveaways/cmqh0qohe02jk01pohd5l12ax/refresh-publication',
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/-75313361194252/giveaways/cmqh0qohe02jk01pohd5l12ax/refresh-publication',
      expect.objectContaining({
        method: 'POST',
        body: undefined,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('allows saving a VK review draft through the mutation tunnel', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ text: 'На модерации', photoUrls: [], linkUrls: [] });
    const body = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PATCH',
        path: '/channels/-68195407437828/vk-parsing/posts/vkpost-1/review-draft',
        body,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/-68195407437828/vk-parsing/posts/vkpost-1/review-draft',
      expect.objectContaining({
        method: 'PATCH',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it.each([
    ['POST', '/chats/chat-1/broadcast/handoff'],
    ['DELETE', '/chats/chat-1/broadcast/handoff'],
    ['PUT', '/chats/chat-1/broadcasts/broadcast-1'],
    ['DELETE', '/channels/channel-1/broadcasts/broadcast-1'],
    ['POST', '/channels/channel-1/broadcasts/broadcast-1/retry'],
    ['POST', '/chats/chat-1/autopost-rules'],
    ['PUT', '/channels/channel-1/autopost-rules/rule-1'],
    ['DELETE', '/channels/channel-1/autopost-rules/rule-1'],
    ['POST', '/autopost-rules'],
    ['PUT', '/autopost-rules/rule-1'],
    ['DELETE', '/autopost-rules/rule-1'],
    ['POST', '/publications'],
    ['POST', '/publications/test'],
    ['POST', '/publications/calendar-availability'],
    ['PUT', '/publications/publication-1'],
    ['DELETE', '/publications/publication-1'],
    ['POST', '/publications/publication-1/pause'],
    ['POST', '/publications/publication-1/resume'],
    ['POST', '/publications/publication-1/cancel'],
    ['POST', '/publications/publication-1/occurrences/occurrence-1/retry'],
    ['POST', '/publications/publication-1/occurrences/occurrence-1/resolve-ambiguous'],
    ['POST', '/channels/channel-1/polls'],
    ['PUT', '/channels/channel-1/polls/poll-1'],
    ['DELETE', '/channels/channel-1/polls/poll-1'],
    ['POST', '/channels/channel-1/polls/poll-1/publish'],
    ['POST', '/channels/channel-1/polls/poll-1/close'],
    ['POST', '/channels/channel-1/polls/poll-1/refresh'],
    ['POST', '/channels/channel-1/polls/poll-1/reset-publication'],
    ['POST', '/chats/chat-1/polls'],
    ['PUT', '/chats/chat-1/polls/poll-1'],
    ['DELETE', '/chats/chat-1/polls/poll-1'],
    ['POST', '/chats/chat-1/polls/poll-1/publish'],
    ['POST', '/chats/chat-1/polls/poll-1/close'],
    ['POST', '/chats/chat-1/polls/poll-1/refresh'],
    ['POST', '/chats/chat-1/polls/poll-1/reset-publication'],
  ])('allows managed broadcast %s %s through the mutation tunnel', async (method, path) => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    await controller.tunnel(
      {
        method,
        path,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:3001/api/v1${path}`,
      expect.objectContaining({
        method,
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
  });

  it('accepts gzip-compressed tunnel bodies', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({ message: 'x'.repeat(4096) });
    const bodyGzip = gzipSync(Buffer.from(payload, 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');

    global.fetch = jest.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch;

    await controller.tunnel(
      {
        method: 'PUT',
        path: '/chats/chat-1/settings',
        bodyGzip,
        contentType: 'application/json',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/chats/chat-1/settings',
      expect.objectContaining({
        method: 'PUT',
        body: payload,
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalledWith();
  });

  it('rejects gzip bodies whose decompressed output exceeds the tunnel limit', async () => {
    const controller = new MiniappMutationTunnelController();
    const bodyGzip = gzipSync(Buffer.from('x'.repeat(128 * 1024 + 1), 'utf8'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        {
          method: 'PUT',
          path: '/chats/chat-1/settings',
          bodyGzip,
          contentType: 'application/json',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('bounds active chunked uploads per validated user and across the process', async () => {
    const controller = new MiniappMutationTunnelController();
    const storePart = async (index: number, userId: string) =>
      controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: `active-upload-${String(index).padStart(4, '0')}`,
          chunkIndex: '0',
          chunkCount: '2',
          chunk: 'eA',
        },
        `InitData auth_date=${index + 1}&hash=test-${index}`,
        { ...TEST_USER, userId },
        createReply() as never,
      );

    try {
      await storePart(0, 'same-user');
      await storePart(1, 'same-user');
      await expect(storePart(2, 'same-user')).rejects.toThrow(BadRequestException);

      for (let index = 2; index < 16; index += 1) {
        await storePart(index, `user-${index}`);
      }
      await expect(storePart(16, 'user-16')).rejects.toThrow(BadRequestException);
    } finally {
      controller.onModuleDestroy();
    }
  });

  it('assembles chunked tunnel bodies before forwarding the mutation', async () => {
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();
    const payload = JSON.stringify({
      imageBase64: 'x'.repeat(16_000),
      imageMimeType: 'image/jpeg',
    });
    const encoded = Buffer.from(payload, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/u, '');
    const chunks = Array.from({ length: Math.ceil(encoded.length / 4_200) }, (_, index) =>
      encoded.slice(index * 4_200, (index + 1) * 4_200),
    );

    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    ) as typeof fetch;

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const chunkReply = createReply();
      await controller.tunnel(
        {
          method: 'POST',
          path: '/channels/channel-1/broadcast',
          contentType: 'application/json',
          uploadId: 'test-upload-id-123456',
          chunkIndex: String(chunkIndex),
          chunkCount: String(chunks.length),
          chunk,
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        chunkReply as never,
      );
      expect(chunkReply.status).toHaveBeenCalledWith(200);
    }

    await controller.tunnel(
      {
        method: 'POST',
        path: '/channels/channel-1/broadcast',
        contentType: 'application/json',
        uploadId: 'test-upload-id-123456',
        chunkCount: String(chunks.length),
        commit: '1',
      },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/v1/channels/channel-1/broadcast',
      expect.objectContaining({
        method: 'POST',
        body: Buffer.from(payload, 'utf8'),
        headers: expect.objectContaining({
          Authorization: 'InitData auth_date=1&hash=test',
          'Content-Type': 'application/json',
          'X-Miniapp-Mutation-Tunnel': '1',
        }),
      }),
    );
    expect(reply.status).toHaveBeenCalledWith(200);
    expect(reply.send).toHaveBeenCalledWith(JSON.stringify({ ok: true }));
  });

  it('rejects ambiguous compressed and plain tunnel bodies', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        {
          method: 'PUT',
          path: '/chats/chat-1/settings',
          body: 'e30',
          bodyGzip: 'e30',
        },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects recursive tunnel targets', async () => {
    const controller = new MiniappMutationTunnelController();

    await expect(
      controller.tunnel(
        { method: 'POST', path: '/_mutation-tunnel' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects targets outside the miniapp mutation allowlist', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        { method: 'POST', path: '/mode' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed tunnel bodies before forwarding', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn() as typeof fetch;

    await expect(
      controller.tunnel(
        { method: 'PUT', path: '/chats/chat-1/settings', body: 'not-valid*' },
        'InitData auth_date=1&hash=test',
        TEST_USER,
        createReply() as never,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('maps local API aborts to a gateway timeout', async () => {
    jest.useFakeTimers();
    const controller = new MiniappMutationTunnelController();
    const reply = createReply();

    global.fetch = jest.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    ) as typeof fetch;

    const request = controller.tunnel(
      { method: 'PUT', path: '/channels/channel-1/settings', body: 'e30' },
      'InitData auth_date=1&hash=test',
      TEST_USER,
      reply as never,
    );
    const assertion = expect(request).rejects.toThrow(GatewayTimeoutException);

    await jest.advanceTimersByTimeAsync(25_000);
    await assertion;
  });
});

describe('ChunkedMutationTunnelUploadStore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('retains the full 34 MiB product payload budget', () => {
    expect(DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes).toBe(34 * 1024 * 1024);
    expect(DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxRetainedBytes).toBeGreaterThanOrEqual(
      DEFAULT_CHUNKED_MUTATION_TUNNEL_UPLOAD_LIMITS.maxBodyBytes,
    );
  });

  it('enforces aggregate bytes and keeps replacement accounting atomic', () => {
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 4,
      maxActiveUploadsPerUser: 4,
      maxBodyBytes: 10,
      maxRetainedBytes: 10,
      ttlMs: 60_000,
    });
    const uploadAMetadata = createUploadMetadata();
    const uploadBMetadata = createUploadMetadata({
      authHash: 'auth-hash-2',
      authUserKey: 'user-key-2',
    });

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata: uploadAMetadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(8, 1),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-b',
          metadata: uploadBMetadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(3, 2),
        }),
      ).toThrow(BadRequestException);
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 8 });

      store.storeChunk({
        uploadId: 'upload-b',
        metadata: uploadBMetadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(2, 2),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-a',
          metadata: uploadAMetadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(9, 3),
        }),
      ).toThrow(BadRequestException);
      expect(store.getUsage()).toMatchObject({ activeUploads: 2, retainedBytes: 10 });

      const committed = store.beginCompletedUpload('upload-a', uploadAMetadata);
      expect(committed.chunks[0]).toEqual(Buffer.alloc(8, 1));
      expect(store.getUsage()).toMatchObject({ activeUploads: 2, retainedBytes: 10 });
      expect(store.deleteUpload('upload-a')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 2 });
      expect(store.deleteUpload('upload-b')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
    } finally {
      store.dispose();
    }
  });

  it('rejects an oversized replacement without discarding the accepted chunk', () => {
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 2,
      maxActiveUploadsPerUser: 2,
      maxBodyBytes: 8,
      maxRetainedBytes: 20,
      ttlMs: 60_000,
    });
    const metadata = createUploadMetadata();

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata,
        chunkIndex: 0,
        chunk: Buffer.alloc(8, 1),
      });
      expect(() =>
        store.storeChunk({
          uploadId: 'upload-a',
          metadata,
          chunkIndex: 0,
          chunk: Buffer.alloc(9, 2),
        }),
      ).toThrow(BadRequestException);

      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 8 });
      expect(store.beginCompletedUpload('upload-a', metadata).chunks[0]).toEqual(
        Buffer.alloc(8, 1),
      );
      expect(store.deleteUpload('upload-a')).toBe(true);
      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
    } finally {
      store.dispose();
    }
  });

  it('expires uploads and releases count and byte budgets without another request', async () => {
    jest.useFakeTimers();
    const store = new ChunkedMutationTunnelUploadStore({
      maxActiveUploads: 1,
      maxActiveUploadsPerUser: 1,
      maxBodyBytes: 4,
      maxRetainedBytes: 4,
      ttlMs: 1_000,
    });

    try {
      store.storeChunk({
        uploadId: 'upload-a',
        metadata: createUploadMetadata({ chunkCount: 2 }),
        chunkIndex: 0,
        chunk: Buffer.alloc(4, 1),
      });
      expect(store.getUsage()).toMatchObject({ activeUploads: 1, retainedBytes: 4 });

      await jest.advanceTimersByTimeAsync(1_000);

      expect(store.getUsage()).toMatchObject({ activeUploads: 0, retainedBytes: 0 });
      expect(store.getUsage().activeUploadsByUser.size).toBe(0);
    } finally {
      store.dispose();
    }
  });
});
