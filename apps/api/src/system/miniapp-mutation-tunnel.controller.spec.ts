import { BadRequestException, GatewayTimeoutException } from '@nestjs/common';
import { gzipSync } from 'node:zlib';
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

describe('MiniappMutationTunnelController', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
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
      reply as never,
    );
    const assertion = expect(request).rejects.toThrow(GatewayTimeoutException);

    await jest.advanceTimersByTimeAsync(25_000);
    await assertion;
  });
});
