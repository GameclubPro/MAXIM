import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

type MaxBotContextStore = {
  botId: string;
};

@Injectable()
export class MaxBotContextService {
  private readonly storage = new AsyncLocalStorage<MaxBotContextStore>();

  runWithBot<T>(botId: string, callback: () => Promise<T> | T): Promise<T> | T {
    return this.storage.run({ botId }, callback);
  }

  getActiveBotId(): string | null {
    return this.storage.getStore()?.botId ?? null;
  }
}
