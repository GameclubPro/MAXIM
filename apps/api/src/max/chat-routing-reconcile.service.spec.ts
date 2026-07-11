import { ChatRoutingReconcileService } from './chat-routing-reconcile.service';

function extractSqlText(query: unknown): string {
  const strings = (query as { strings?: readonly string[] } | null)?.strings;
  return Array.isArray(strings) ? strings.join(' ') : String(query);
}

describe('ChatRoutingReconcileService', () => {
  const originalAppRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'enqueue';
  });

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.clearAllMocks();
  });

  function createService(params?: {
    requests?: Array<{ chat_id: string; generation: bigint }>;
    reconcile?: jest.Mock;
    executeRaw?: jest.Mock;
    concurrency?: number;
  }) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(params?.requests ?? []),
      $executeRaw: params?.executeRaw ?? jest.fn().mockResolvedValue(1),
    };
    const maxBotLinkService = {
      reconcileChatRoutingState:
        params?.reconcile ?? jest.fn().mockResolvedValue({ routingState: 'READY', changed: true }),
    };
    const config = {
      get: jest.fn((key: string, fallback?: number) =>
        key === 'CHAT_ROUTING_RECONCILE_CONCURRENCY' ? (params?.concurrency ?? fallback) : fallback,
      ),
    };
    const service = new ChatRoutingReconcileService(
      prisma as never,
      maxBotLinkService as never,
      config as never,
    );
    return { service, prisma, maxBotLinkService };
  }

  it('claims dirty rows with an expiring lease and force-bumps every routing epoch', async () => {
    const { service, prisma, maxBotLinkService } = createService({
      requests: [
        { chat_id: 'chat-1', generation: 4n },
        { chat_id: 'chat-2', generation: 2n },
      ],
    });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(2);

    expect(maxBotLinkService.reconcileChatRoutingState).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.reconcileChatRoutingState).toHaveBeenCalledWith({
      chatId: 'chat-1',
      forceVersionBump: true,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE SKIP LOCKED');
    expect(extractSqlText(prisma.$queryRaw.mock.calls[0]?.[0])).toContain('"lease_expires_at"');
    expect(
      prisma.$executeRaw.mock.calls.every(([query]) =>
        extractSqlText(query).includes('DELETE FROM'),
      ),
    ).toBe(true);
  });

  it('releases a failed request for retry without failing the rest of the batch', async () => {
    const reconcile = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient database failure'))
      .mockResolvedValueOnce({ routingState: 'READY', changed: true });
    const { service, prisma } = createService({
      requests: [
        { chat_id: 'chat-failed', generation: 3n },
        { chat_id: 'chat-ok', generation: 1n },
      ],
      reconcile,
      concurrency: 2,
    });

    await expect(
      (
        service as unknown as {
          reconcileBatch: () => Promise<number>;
        }
      ).reconcileBatch(),
    ).resolves.toBe(2);

    const statements = prisma.$executeRaw.mock.calls.map(([query]) => extractSqlText(query));
    expect(statements.some((statement) => statement.includes('"lease_token" = NULL'))).toBe(true);
    expect(statements.some((statement) => statement.includes('DELETE FROM'))).toBe(true);
  });

  it('actually processes a multi-row batch concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return { routingState: 'READY', changed: true };
    });
    const { service } = createService({
      requests: Array.from({ length: 6 }, (_, index) => ({
        chat_id: `chat-${index + 1}`,
        generation: 1n,
      })),
      reconcile,
      concurrency: 6,
    });

    const batch = (
      service as unknown as {
        reconcileBatch: () => Promise<number>;
      }
    ).reconcileBatch();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maxActive).toBe(6);
    release();
    await expect(batch).resolves.toBe(6);
  });
});
