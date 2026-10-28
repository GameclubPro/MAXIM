import type pg from 'pg';

export const ERASER_RATE_LIMIT_READER_VERSION = 1;

export interface RateLimitStore {
  remainingMs(): Promise<number>;
  extend(ms: number): Promise<void>;
}

export class DurableRateLimit implements RateLimitStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly botId: string,
  ) {}

  async remainingMs(): Promise<number> {
    const result = await this.pool.query<{ remaining_ms: string }>(
      `SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (not_before-clock_timestamp()))*1000))::text
         AS remaining_ms FROM eraser_rate_limits WHERE bot_id=$1`,
      [this.botId],
    );
    return Number(result.rows[0]?.remaining_ms ?? 0);
  }

  async extend(ms: number): Promise<void> {
    if (!Number.isSafeInteger(ms) || ms < 1000) throw new Error('Invalid cooldown duration');
    // FLAG: A Redis outage or restart cannot erase a received token-wide Retry-After.
    await this.pool.query(
      `INSERT INTO eraser_rate_limits(bot_id,not_before)
       VALUES($1,clock_timestamp()+($2::double precision*INTERVAL '1 millisecond'))
       ON CONFLICT(bot_id) DO UPDATE SET not_before=GREATEST(eraser_rate_limits.not_before,EXCLUDED.not_before)`,
      [this.botId, ms],
    );
  }
}
