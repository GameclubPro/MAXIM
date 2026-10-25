import type { PrismaClient } from '../prisma/prisma-client';
import {
  confirmEraserSourceHolds,
  EraserSourceHoldBarrierError,
} from './eraser-source-hold-barrier';

describe('independent source hold acknowledgement', () => {
  const originalUrl = process.env.ERASER_CONTROL_URL;
  const originalToken = process.env.ERASER_CONTROL_TOKEN;
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.ERASER_CONTROL_URL;
    else process.env.ERASER_CONTROL_URL = originalUrl;
    if (originalToken === undefined) delete process.env.ERASER_CONTROL_TOKEN;
    else process.env.ERASER_CONTROL_TOKEN = originalToken;
  });
  function database(owned: boolean): Pick<PrismaClient, '$queryRaw'> {
    return { $queryRaw: jest.fn().mockResolvedValue([{ owned }]) };
  }
  function configured() {
    process.env.ERASER_CONTROL_URL = 'http://eraser:3000';
    process.env.ERASER_CONTROL_TOKEN = 'control-only';
  }

  it('needs no service when no chat has independent ownership', async () => {
    const fetch = jest.spyOn(global, 'fetch');
    await confirmEraserSourceHolds(database(false), [{ chatId: '-1', messageId: 'm' }], ['u']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends exact modern messages without broadening author immunity', async () => {
    configured();
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"success":true}'));
    await confirmEraserSourceHolds(database(true), [{ chatId: '-1', messageId: 'm' }]);
    expect(fetch).toHaveBeenCalledWith(
      'http://eraser:3000/internal/v1/holds',
      expect.objectContaining({
        body: JSON.stringify({
          holdMessages: [{ chatId: '-1', messageId: 'm' }],
          holdAuthorIds: [],
        }),
        headers: { Authorization: 'Bearer control-only', 'Content-Type': 'application/json' },
      }),
    );
  });

  it('deduplicates and bounds legacy message/global-author batches', async () => {
    configured();
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('{"success":true}'));
    const messages = Array.from({ length: 1001 }, (_, i) => ({
      chatId: '-1',
      messageId: String(i),
    }));
    await confirmEraserSourceHolds(database(true), [...messages, messages[0]!], ['u', 'u']);
    const payloads = fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)));
    expect(payloads.map((row) => row.holdMessages.length)).toEqual([500, 500, 1]);
    expect(payloads.map((row) => row.holdAuthorIds)).toEqual([['u'], [], []]);
  });

  it.each(['refused', 'lost', 'invalid'] as const)(
    'refuses source installation when acknowledgement is %s',
    async (kind) => {
      configured();
      jest.spyOn(global, 'fetch').mockImplementation(async () => {
        if (kind === 'lost') throw new Error('private transport details');
        return kind === 'refused'
          ? new Response('{}', { status: 409 })
          : new Response('{"success":false}');
      });
      await expect(
        confirmEraserSourceHolds(database(true), [{ chatId: '-1', messageId: 'm' }], ['u']),
      ).rejects.toBeInstanceOf(EraserSourceHoldBarrierError);
    },
  );

  it('requires credentials even when the API feature flag is off', async () => {
    delete process.env.ERASER_CONTROL_URL;
    delete process.env.ERASER_CONTROL_TOKEN;
    await expect(
      confirmEraserSourceHolds(database(true), [{ chatId: '-1', messageId: 'm' }]),
    ).rejects.toBeInstanceOf(EraserSourceHoldBarrierError);
  });

  it('protects an online adoption before the first ownership binding exists', async () => {
    configured();
    const db = database(false);
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"success":true}'));
    await confirmEraserSourceHolds(db, [{ chatId: '-1', messageId: 'old-human-rules' }], [], true);
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
