import { PrivateControlSessionBotContext } from './private-control-session-bot-context';

describe('PrivateControlSessionBotContext', () => {
  it('keeps concurrent bot scopes isolated', async () => {
    const context = new PrivateControlSessionBotContext();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = context.run('bot-1', async () => {
      await firstBlocked;
      return context.currentBotId();
    });
    const second = context.run('bot-2', async () => context.currentBotId());

    await expect(second).resolves.toBe('bot-2');
    releaseFirst();
    await expect(first).resolves.toBe('bot-1');
    expect(context.currentBotId()).toBeNull();
  });

  it('normalizes bot IDs and preserves an existing matching scope', async () => {
    const context = new PrivateControlSessionBotContext();

    await expect(
      context.run(' bot-1 ', () => context.run('bot-1', async () => context.currentBotId())),
    ).resolves.toBe('bot-1');
  });
});
