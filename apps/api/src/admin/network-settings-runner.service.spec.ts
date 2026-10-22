import { Test, type TestingModule } from '@nestjs/testing';
import { NetworkSettingsRunnerService } from './network-settings-runner.service';
import { NetworkSettingsService } from './network-settings.service';

describe('network settings runner scheduling', () => {
  const previousRole = process.env.APP_ROLE;
  let moduleRef: TestingModule;
  let closing: Promise<void> | null;
  let runner: NetworkSettingsRunnerService;
  let tick: jest.MockedFunction<NetworkSettingsService['tick']>;
  const closeModule = () => (closing ??= moduleRef.close());

  beforeEach(async () => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'action';
    closing = null;
    tick = jest.fn<
      ReturnType<NetworkSettingsService['tick']>,
      Parameters<NetworkSettingsService['tick']>
    >();
    tick.mockResolvedValue(false);
    const settings = { tick } satisfies Pick<NetworkSettingsService, 'tick'>;
    moduleRef = await Test.createTestingModule({
      providers: [
        NetworkSettingsRunnerService,
        { provide: NetworkSettingsService, useValue: settings },
      ],
    }).compile();
    runner = moduleRef.get<NetworkSettingsRunnerService>(NetworkSettingsRunnerService);
  });

  afterEach(async () => {
    await closeModule();
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });

  it('starts immediately and advances three durable stages in 500ms before returning to idle polling', async () => {
    tick.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(tick.mock.calls).toEqual([[2], [2], [2]]);
    await jest.advanceTimersByTimeAsync(250);
    expect(tick).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(tick).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(5);
  });

  it('limits a continuous progress burst to twenty fair passes and then yields for five seconds', async () => {
    tick.mockResolvedValue(true);
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(4_750);
    expect(tick).toHaveBeenCalledTimes(20);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(tick).toHaveBeenCalledTimes(20);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(21);
    expect(tick.mock.calls.every((args) => args.length === 1 && args[0] === 2)).toBe(true);
  });

  it('does not overlap a slow pass and counts its elapsed time against the progress budget', async () => {
    let finish!: (value: boolean) => void;
    tick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(tick).toHaveBeenCalledTimes(1);
    finish(true);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('backs off for five seconds after a failed pass', async () => {
    tick.mockRejectedValueOnce(new Error('Store unavailable'));
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(tick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it('drains its owned pass on shutdown without scheduling a continuation', async () => {
    let finish!: (value: boolean) => void;
    tick.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stopping = closeModule().then(() => {
      stopped = true;
    });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(false);
    expect(tick).toHaveBeenCalledTimes(1);
    finish(true);
    await stopping;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(stopped).toBe(true);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('never starts in an HTTP-only role', async () => {
    process.env.APP_ROLE = 'admin';
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(tick).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
