import { ManagedPollService } from './managed-poll.service';
import type { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';

const run = { action: 'run' as const, retryAfterMs: 0, reason: 'healthy' };
const pause = { action: 'pause' as const, retryAfterMs: 120_000, reason: 'max_api' };
const slow = { action: 'slow' as const, retryAfterMs: 120_000, reason: 'pressure' };

function fixture() {
  const query = jest.fn().mockResolvedValue([
    { id: 'a', chatId: 'chat-a' },
    { id: 'b', chatId: 'chat-b' },
  ]);
  const governor = {
    decide: jest
      .fn<
        ReturnType<BackgroundRuntimeGovernorService['decide']>,
        Parameters<BackgroundRuntimeGovernorService['decide']>
      >()
      .mockResolvedValue(run),
  } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
  const service = new ManagedPollService(
    { $queryRaw: query } as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    governor as never,
  );
  const runtime = service as unknown as {
    runPollRenderSerialized: (id: string, operation: () => Promise<void>) => Promise<boolean>;
    renderPollPublication: (chatId: string, pollId: string, action: string) => Promise<boolean>;
  };
  const serialized = jest
    .spyOn(runtime, 'runPollRenderSerialized')
    .mockImplementation(async (_id, operation) => {
      await operation();
      return true;
    });
  const render = jest.spyOn(runtime, 'renderPollPublication').mockResolvedValue(true);
  return { service, query, governor, render, serialized };
}

describe('poll repair yields to production pressure', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('pauses before SQL and honors the governor retry interval', async () => {
    const f = fixture();
    f.governor.decide.mockResolvedValue(pause);
    expect(await f.service.processPendingPollRenderRepairs()).toBe(0);
    expect(f.query).not.toHaveBeenCalled();
    f.governor.decide.mockResolvedValue(run);
    expect(await f.service.processPendingPollRenderRepairs()).toBe(0);
    jest.advanceTimersByTime(120_000);
    expect(await f.service.processPendingPollRenderRepairs()).toBe(2);
  });

  it('rechecks pressure after selection and between edits', async () => {
    const f = fixture();
    f.governor.decide
      .mockResolvedValueOnce(run)
      .mockResolvedValueOnce(run)
      .mockResolvedValue(pause);
    expect(await f.service.processPendingPollRenderRepairs()).toBe(1);
    expect(f.render).toHaveBeenCalledTimes(1);
    const changed = fixture();
    changed.governor.decide.mockResolvedValueOnce(run).mockResolvedValue(pause);
    expect(await changed.service.processPendingPollRenderRepairs()).toBe(0);
    expect(changed.render).not.toHaveBeenCalled();
  });

  it('admits one slow repair and stops new work after the pass budget', async () => {
    const f = fixture();
    f.governor.decide.mockResolvedValue(slow);
    expect(await f.service.processPendingPollRenderRepairs()).toBe(1);
    expect(f.render).toHaveBeenCalledTimes(1);
    const bounded = fixture();
    bounded.render.mockImplementationOnce(async () => {
      jest.advanceTimersByTime(5_001);
      return true;
    });
    expect(await bounded.service.processPendingPollRenderRepairs()).toBe(1);
    expect(bounded.render).toHaveBeenCalledTimes(1);
  });

  it('does not start another edit after shutdown begins during the owned repair', async () => {
    const f = fixture();
    let stopping = false;
    f.render.mockImplementationOnce(async () => {
      stopping = true;
      return true;
    });
    expect(
      await f.service.processPendingPollRenderRepairs({ shouldContinue: () => !stopping }),
    ).toBe(1);
    expect(f.render).toHaveBeenCalledTimes(1);
  });

  it.each(['governor', 'render-lock'] as const)(
    'checks shutdown after awaiting %s',
    async (wait) => {
      const f = fixture();
      let stopping = false;
      if (wait === 'governor')
        f.governor.decide.mockResolvedValueOnce(run).mockImplementationOnce(async () => {
          stopping = true;
          return run;
        });
      else
        f.serialized.mockImplementationOnce(async (_id, operation) => {
          stopping = true;
          await operation();
          return true;
        });
      expect(
        await f.service.processPendingPollRenderRepairs({ shouldContinue: () => !stopping }),
      ).toBe(0);
      expect(f.render).not.toHaveBeenCalled();
    },
  );
});
