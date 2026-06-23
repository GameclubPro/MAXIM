import { createAdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';

describe('AdminManagedBroadcastRuntimeContext', () => {
  it('reads and writes legacy target properties through a typed bridge', () => {
    const target = { value: 1 } as { value: number; extra?: string };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    expect(context.read('value')).toBe(1);

    context.write('extra', 'ok');

    expect(target.extra).toBe('ok');
  });

  it('exposes managed broadcast infrastructure through explicit typed accessors', async () => {
    const snapshot = { mode: 'normal' } as never;
    const target = {
      prisma: { managedBroadcast: {} },
      maxClient: { sendMessage: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn() },
      backgroundRuntimeGovernorService: { decide: jest.fn() },
      managedEntityAccessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      managedBroadcastDegradePauseLogAtMs: 17,
      resolveSystemModeSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.backgroundRuntimeGovernorService).toBe(
      target.backgroundRuntimeGovernorService,
    );
    expect(context.managedEntityAccessLossService).toBe(target.managedEntityAccessLossService);
    expect(context.managedBroadcastDegradePauseLogAtMs).toBe(17);

    context.managedBroadcastDegradePauseLogAtMs = 23;

    expect(target.managedBroadcastDegradePauseLogAtMs).toBe(23);
    await expect(context.resolveSystemModeSnapshot()).resolves.toBe(snapshot);
    expect(target.resolveSystemModeSnapshot).toHaveBeenCalledTimes(1);
  });
});
