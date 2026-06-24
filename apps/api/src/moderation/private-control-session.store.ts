import type { Logger } from '@nestjs/common';
import { SESSION_KEY_PREFIX, SESSION_TTL_SEC } from './private-control.constants';
import type { PrivateSession } from './private-control.types';
import type { RedisCounterService } from './redis-counter.service';

export class PrivateControlSessionStore {
  private readonly memorySession = new Map<
    string,
    { expiresAt: number; session: PrivateSession }
  >();

  constructor(
    private readonly options: {
      redisCounter?: RedisCounterService;
      logger: Pick<Logger, 'warn'>;
      normalizeSession(raw: unknown): PrivateSession;
      createDefaultSession(): PrivateSession;
    },
  ) {}

  async loadSession(userId: string): Promise<PrivateSession> {
    const sessionKey = this.sessionKey(userId);
    if (this.options.redisCounter) {
      const raw = await this.options.redisCounter.getString(sessionKey);
      if (raw) {
        try {
          return this.options.normalizeSession(JSON.parse(raw));
        } catch (error: unknown) {
          this.options.logger.warn(
            {
              userId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to parse private control session from redis',
          );
        }
      }
    }

    const memory = this.memorySession.get(sessionKey);
    if (memory && memory.expiresAt > Date.now()) {
      return this.options.normalizeSession(memory.session);
    }

    return this.options.createDefaultSession();
  }

  async loadSessionForDiagnostics(userId: string): Promise<PrivateSession | null> {
    try {
      return await this.loadSession(userId);
    } catch (error: unknown) {
      this.options.logger.warn(
        {
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load private control session for diagnostics',
      );
      return null;
    }
  }

  async saveSession(userId: string, session: PrivateSession): Promise<void> {
    const normalized = this.options.normalizeSession(session);
    const sessionKey = this.sessionKey(userId);

    if (this.options.redisCounter) {
      await this.options.redisCounter.setStringWithTtl(
        sessionKey,
        JSON.stringify(normalized),
        SESSION_TTL_SEC,
      );
      return;
    }

    this.memorySession.set(sessionKey, {
      expiresAt: Date.now() + SESSION_TTL_SEC * 1_000,
      session: normalized,
    });
  }

  sessionKey(userId: string): string {
    return `${SESSION_KEY_PREFIX}:${userId}`;
  }
}
