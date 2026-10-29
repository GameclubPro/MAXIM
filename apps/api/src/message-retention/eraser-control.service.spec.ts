import { ConfigService } from '@nestjs/config';
import { EraserControlService } from './eraser-control.service';
import type { PrismaService } from '../prisma/prisma.service';
import { retentionOperationId } from '../admin/network-settings.service';

describe('Lastik control transport', () => {
  afterEach(() => jest.restoreAllMocks());

  function client(enabled = true) {
    return new EraserControlService(
      {} as PrismaService,
      new ConfigService({
        ERASER_ENABLED: enabled,
        ERASER_CONTROL_URL: 'http://eraser:3000',
        ERASER_CONTROL_TOKEN: 'independent-control-token-not-bot-token',
      }),
    );
  }

  it('uses only control Authorization and never forwards a bot token', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
    await expect(client().request('/chats/-1/policy')).resolves.toEqual({ enabled: false });
    expect(fetch).toHaveBeenCalledWith(
      'http://eraser:3000/internal/v1/chats/-1/policy',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer independent-control-token-not-bot-token',
          'Content-Type': 'application/json',
        },
      }),
    );
  });

  it('keeps configured reads available with execution disabled and redacts unreachable errors', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('private upstream details'));
    await expect(client(false).request('/chats/-1/policy')).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const error = await client()
      .request('/chats/-1/policy')
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 503 });
    expect(String(error)).not.toContain('private upstream details');
  });

  it('blocks policy and retry writes before transport when execution is disabled', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await expect(client(false).request('/chats/-1/policy', 'PUT', {})).rejects.toMatchObject({
      status: 503,
    });
    await expect(client(false).request('/chats/-1/retry', 'POST', {})).rejects.toMatchObject({
      status: 503,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a revision conflict without disclosing upstream bodies', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ token: 'sensitive upstream body' }), { status: 409 }),
      );
    const error = await client()
      .request('/chats/-1/policy', 'PUT', {})
      .catch((value: unknown) => value);
    expect(error).toMatchObject({ status: 409 });
    expect(String(error)).not.toContain('sensitive');
  });

  it('derives stable, distinct per-chat UUIDs for network retries', () => {
    const id = retentionOperationId('operation', '-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(retentionOperationId('operation', '-1')).toBe(id);
    expect(retentionOperationId('operation', '-2')).not.toBe(id);
    expect(retentionOperationId('other', '-1')).not.toBe(id);
  });

  it.each([
    ['ERASER_CONNECTION_REQUIRED', 'Добавьте Ластика'],
    ['ERASER_OPERATION_CONFLICT', 'Идентификатор сохранения'],
    ['ERASER_PROTECTION_PENDING', 'защиту правил'],
    ['MESSAGE_RETENTION_REVISION_CONFLICT', 'Обновите настройки'],
  ])('preserves typed %s conflicts with a safe product explanation', async (code, message) => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code, message: 'private upstream content' }), {
        status: 409,
      }),
    );
    const error = await client()
      .request('/chats/-1/policy', 'PUT', {})
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      status: 409,
      response: { code, message: expect.stringContaining(message) },
    });
    expect(String(error)).not.toContain('private upstream');
  });
});
