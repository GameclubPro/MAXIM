import { BadRequestException } from '@nestjs/common';
import { MiniappMutationTunnelController } from './miniapp-mutation-tunnel.controller';

describe('participant report WebView mutations', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('forwards only the scoped dismiss command with the authenticated credentials', async () => {
    const controller = new MiniappMutationTunnelController();
    global.fetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const reply = { header: jest.fn(), status: jest.fn(), send: jest.fn() };
    try {
      await controller.tunnel(
        { method: 'POST', path: '/chats/chat-1/reports/report-1/dismiss' },
        'InitData test',
        { userId: 'admin', username: null, displayName: 'Admin' },
        reply as never,
      );
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:3001/api/v1/chats/chat-1/reports/report-1/dismiss',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'InitData test' }),
        }),
      );
      await expect(
        controller.tunnel(
          { method: 'POST', path: '/channels/chat-1/reports/report-1/dismiss' },
          'InitData test',
          { userId: 'admin', username: null, displayName: 'Admin' },
          reply as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    } finally {
      controller.onModuleDestroy();
    }
  });
});
