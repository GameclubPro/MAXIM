import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

export type PublisherAccessProbeOutcome =
  | 'confirmed'
  | 'denied'
  | 'superseded'
  | 'deferred'
  | 'transient_error';
export const PUBLISHER_ROSTER_INTERVAL_MS = 30 * 60_000;
export const PUBLISHER_BOT_EXPIRY_URGENCY_MS = 60_000;

@Injectable()
export class PublisherAccessRefreshPolicy {
  readonly mode: 'off' | 'canary' | 'on';

  constructor(@Optional() config?: ConfigService) {
    const value = config?.get<string>('MAX_PUBLISHER_ACCESS_REFRESH_MODE', 'off');
    this.mode = value === 'canary' || value === 'on' ? value : 'off';
  }

  get deadlinePrioritiesEnabled(): boolean {
    // FLAG: Priority is queue-wide. Old maintenance in the other 90% must not overtake
    // publication probes; only the reduced roster frequency is entity-canary scoped.
    return this.mode !== 'off';
  }

  separatesMaintenance(botId: string, chatId: string): boolean {
    return this.mode === 'on' || (this.mode === 'canary' && this.bucket(botId, chatId) % 10 === 0);
  }

  initialRosterRefreshAt(botId: string, chatId: string, now: Date): Date {
    return new Date(now.getTime() + (this.bucket(botId, chatId) % PUBLISHER_ROSTER_INTERVAL_MS));
  }

  private bucket(botId: string, chatId: string): number {
    // FLAG: This hash selects rollout cohorts, never authentication or execution authority.
    return createHash('sha256')
      .update(JSON.stringify([botId, chatId]))
      .digest()
      .readUInt32BE(0);
  }
}

export function publisherRosterRetryAt(error: unknown, now = Date.now()): Date {
  const value = error as {
    retryAfterMs?: unknown;
    response?: { headers?: Record<string, unknown> };
  } | null;
  const header =
    value?.response?.headers?.['retry-after'] ?? value?.response?.headers?.['Retry-After'];
  const delays: number[] = [60_000];
  const add = (delay: number) => {
    if (Number.isFinite(delay) && delay >= 0 && delay <= 8_640_000_000_000_000 - now)
      delays.push(delay);
  };
  if (typeof value?.retryAfterMs === 'number') add(value.retryAfterMs);
  for (const raw of Array.isArray(header) ? header : [header]) {
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const text = String(raw).trim();
    if (/^\d+(?:\.\d+)?$/.test(text)) add(Number(text) * 1_000);
    else if (/[A-Za-z]/.test(text)) add(Date.parse(text) - now);
  }
  return new Date(now + Math.max(...delays));
}
