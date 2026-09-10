import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { RedisCounterService } from '../redis-counter.service';

export const MESSAGE_DUPLICATE_CONTROL_KEY = 'message-duplicate:runtime-control:v1';
const messageDuplicateControlV1Schema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(['off', 'shadow', 'delete_only']),
    chatIds: z.array(z.string().regex(/^-[1-9][0-9]{0,19}$/)).max(1000),
    expiresAt: z.iso.datetime(),
    effectiveAt: z.iso.datetime(),
  })
  .strict()
  .refine((value) => new Set(value.chatIds).size === value.chatIds.length)
  .refine(
    (value) =>
      Date.parse(value.expiresAt) > Date.parse(value.effectiveAt) &&
      Date.parse(value.expiresAt) - Date.parse(value.effectiveAt) <= 86400000,
  );

const messageDuplicateControlV2Schema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(['off', 'shadow', 'delete_only', 'full']),
    scope: z.enum(['chats', 'all_enabled_chats']),
    chatIds: z.array(z.string().regex(/^-[1-9][0-9]{0,19}$/)).max(1000),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.chatIds).size === value.chatIds.length &&
      (value.scope !== 'all_enabled_chats' || value.chatIds.length === 0),
  )
  .refine(
    (value) =>
      value.expiresAt === null ||
      (Date.parse(value.expiresAt) > Date.parse(value.effectiveAt) &&
        Date.parse(value.expiresAt) - Date.parse(value.effectiveAt) <= 86400000),
  );

export const messageDuplicateControlSchema = z.union([
  messageDuplicateControlV1Schema,
  messageDuplicateControlV2Schema,
]);
export function messageDuplicateActionsEnabled(mode: MessageDuplicatePolicy['mode']): boolean {
  return mode === 'delete_only' || mode === 'full';
}

export type MessageDuplicateControl = z.infer<typeof messageDuplicateControlSchema>;
export type MessageDuplicatePolicy = {
  mode: MessageDuplicateControl['mode'];
  revision: number;
  expiresAtMs: number;
  effectiveAtMs: number;
};

const OFF: MessageDuplicatePolicy = { mode: 'off', revision: 0, expiresAtMs: 0, effectiveAtMs: 0 };

@Injectable()
export class MessageDuplicatePolicyService {
  private readonly logger = new Logger(MessageDuplicatePolicyService.name);
  private cached: MessageDuplicateControl | null = null;
  private cacheUntil = 0;
  private warnedAt = 0;
  private loading: Promise<MessageDuplicateControl | null> | null = null;

  constructor(
    private readonly redis: RedisCounterService,
    private readonly config: ConfigService,
  ) {}

  async resolve(chatId: string, fresh = false): Promise<MessageDuplicatePolicy> {
    if (this.config.get('MESSAGE_DUPLICATE_ENABLED') === false) return OFF;
    try {
      const control = await this.read(fresh);
      const expiresAtMs = control
        ? control.expiresAt === null
          ? Number.MAX_SAFE_INTEGER
          : Date.parse(control.expiresAt)
        : 0;
      const inScope =
        control?.version === 2 && control.scope === 'all_enabled_chats'
          ? /^-[1-9][0-9]{0,19}$/.test(chatId)
          : control?.chatIds.includes(chatId);
      if (!control || expiresAtMs <= Date.now() || !inScope) return OFF;
      return {
        mode: control.mode,
        revision: control.revision,
        expiresAtMs,
        effectiveAtMs: Date.parse(control.effectiveAt),
      };
    } catch {
      if (fresh) throw new Error('Message duplicate control could not be verified');
      if (Date.now() - this.warnedAt > 60_000) {
        this.warnedAt = Date.now();
        this.logger.warn('Message duplicate control unavailable; new matching remains disabled');
      }
      return OFF;
    }
  }

  async snapshot(): Promise<{ revision: number; control: MessageDuplicateControl | null }> {
    const revisionRaw = await this.redis.getString(`${MESSAGE_DUPLICATE_CONTROL_KEY}:revision`);
    const revision = revisionRaw === null ? 0 : Number(revisionRaw);
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new Error('Invalid control revision');
    const control = await this.read(true);
    if (control && control.revision !== revision) throw new Error('Control changed while reading');
    return { revision, control };
  }

  async set(
    input: unknown,
    expectedRevision: number,
  ): Promise<{ applied: boolean; revision: number }> {
    const control = messageDuplicateControlSchema.parse(input);
    const expiresAtMs = control.expiresAt === null ? null : Date.parse(control.expiresAt);
    if (
      control.revision !== expectedRevision + 1 ||
      (expiresAtMs !== null &&
        (expiresAtMs <= Date.now() || expiresAtMs - Date.now() > 24 * 60 * 60_000)) ||
      Date.parse(control.effectiveAt) > Date.now() + 5000 ||
      Date.parse(control.effectiveAt) < Date.now() - 60_000
    )
      throw new Error('Invalid control lifetime or revision');
    const result = await this.redis.compareAndSetRevisionedControl({
      key: MESSAGE_DUPLICATE_CONTROL_KEY,
      expectedRevision,
      value: JSON.stringify(control),
      expiresAtMs,
    });
    this.cacheUntil = 0;
    return result;
  }

  private async read(fresh: boolean): Promise<MessageDuplicateControl | null> {
    if (!fresh && Date.now() < this.cacheUntil) return this.cached;
    const read = async () =>
      raceWithTimeout({
        operation: async () => {
          const value = await this.redis.getString(MESSAGE_DUPLICATE_CONTROL_KEY);
          if (value === null) return null;
          if (value.length > 64 * 1024) throw new Error('Oversized duplicate control');
          return messageDuplicateControlSchema.parse(JSON.parse(value));
        },
        timeoutMs: 250,
        onTimeout: () => {
          throw new Error('Duplicate control deadline');
        },
      });
    // FLAG: Dispatch guards require their own fresh read, never a pre-pause in-flight snapshot.
    if (fresh) return read();
    if (!this.loading) this.loading = read();
    const loading = this.loading;
    try {
      this.cached = await loading;
      this.cacheUntil = Date.now() + 1000;
      return this.cached;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
  }
}
