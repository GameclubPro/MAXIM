import { AsyncLocalStorage } from 'node:async_hooks';

export class PrivateControlSessionBotContext {
  private readonly storage = new AsyncLocalStorage<{ botId: string }>();

  currentBotId(): string | null {
    return this.storage.getStore()?.botId ?? null;
  }

  run<T>(botId: string | null | undefined, operation: () => Promise<T>): Promise<T> {
    const normalizedBotId = typeof botId === 'string' ? botId.trim() : '';
    if (!normalizedBotId || this.currentBotId() === normalizedBotId) {
      return operation();
    }
    return this.storage.run({ botId: normalizedBotId }, operation);
  }
}
