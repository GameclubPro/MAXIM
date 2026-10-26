import type { Config } from './config.js';
import { HttpLimiter } from './limiter.js';
import { record, parseMessage, type Message } from './types.js';

export class MaxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly attempted: boolean,
    readonly retryAfterMs = 1000,
  ) {
    super(`MAX ${status || 'transport'} ${code}`);
  }
}
export type MaxTransport = {
  rights(chatId: string): Promise<void>;
  pin(chatId: string): Promise<string | null>;
  page(chatId: string, upperMs: number, lowerMs?: number): Promise<Message[]>;
  remove(chatId: string, messageId: string, before: () => Promise<void>): Promise<void>;
  presence(chatId: string, messageId: string): Promise<'present' | 'absent' | 'unknown'>;
};
export class MaxClient implements MaxTransport {
  constructor(
    private readonly config: Config,
    private readonly limiter: Pick<HttpLimiter, 'acquire' | 'cooldown'>,
    private readonly http: typeof fetch = fetch,
  ) {}
  private async request(
    method: string,
    path: string,
    options: { chatDelete?: string; before?: () => Promise<void>; body?: unknown } = {},
  ): Promise<Record<string, unknown>> {
    await this.limiter.acquire(options.chatDelete);
    await options.before?.();
    let response: Response;
    try {
      response = await this.http(new URL(path, this.config.apiBaseUrl), {
        method,
        headers: { Authorization: this.config.botToken, 'Content-Type': 'application/json' },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
    } catch {
      throw new MaxError(0, 'transport_unknown', method === 'DELETE');
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = record(await response.json());
    } catch {
      /* An invalid response never certifies an effect. */
    }
    if (!response.ok) {
      const code =
        typeof body?.code === 'string' && /^[a-zA-Z_.-]{1,100}$/.test(body.code)
          ? body.code
          : 'unclassified';
      const retry = response.headers.get('retry-after');
      const retryAfterMs =
        retry && /^\d+(\.\d+)?$/.test(retry)
          ? Math.ceil(Number(retry) * 1000)
          : retry
            ? Math.max(1000, Date.parse(retry) - Date.now())
            : 1000;
      if (response.status === 429)
        await this.limiter.cooldown(Number.isFinite(retryAfterMs) ? retryAfterMs : 1000);
      throw new MaxError(
        response.status,
        code,
        method === 'DELETE' && response.status !== 429,
        Number.isFinite(retryAfterMs) ? retryAfterMs : 1000,
      );
    }
    if (!body) throw new MaxError(0, 'malformed_response', method === 'DELETE');
    return body;
  }
  async rights(chatId: string): Promise<void> {
    const member = await this.request('GET', `/chats/${encodeURIComponent(chatId)}/members/me`);
    const role = String(member.role ?? member.status ?? '').toLowerCase();
    const owner =
      member.is_owner === true || member.isOwner === true || ['owner', 'creator'].includes(role);
    const admin = owner || member.is_admin === true || member.isAdmin === true || role === 'admin';
    if (String(member.user_id ?? record(member.user)?.user_id) !== this.config.botId)
      throw new MaxError(0, 'membership_unknown', false);
    if (!admin) {
      const explicitNonAdmin =
        member.is_admin === false ||
        member.isAdmin === false ||
        ['member', 'user', 'removed'].includes(role);
      throw new MaxError(
        explicitNonAdmin ? 403 : 0,
        explicitNonAdmin ? 'eraser_rights_missing' : 'membership_unknown',
        false,
      );
    }
    if (owner) return;
    if (
      !Array.isArray(member.permissions) ||
      member.permissions.some((permission) => typeof permission !== 'string')
    )
      throw new MaxError(0, 'membership_unknown', false);
    if (!member.permissions.includes('read_all_messages') || !member.permissions.includes('write'))
      throw new MaxError(403, 'eraser_rights_missing', false);
  }

  async pin(chatId: string): Promise<string | null> {
    const result = await this.request('GET', `/chats/${encodeURIComponent(chatId)}/pin`);
    // FLAG: MAX permits an omitted message; only the exact empty envelope confirms no pin.
    if (result.message === null || Object.keys(result).length === 0) return null;
    const row = record(result.message),
      body = record(row?.body),
      recipient = record(row?.recipient);
    if (!body || typeof body.mid !== 'string' || !body.mid || String(recipient?.chat_id) !== chatId)
      throw new MaxError(0, 'pin_unknown', false);
    return body.mid;
  }
  async page(chatId: string, upperMs: number, lowerMs?: number): Promise<Message[]> {
    const query = new URLSearchParams({
      chat_id: chatId,
      count: '100',
      from: String(upperMs),
      ...(lowerMs === undefined ? {} : { to: String(lowerMs) }),
    });
    const result = await this.request('GET', `/messages?${query}`);
    if (!Array.isArray(result.messages) || result.messages.length > 100)
      throw new MaxError(0, 'history_unknown', false);
    const items = result.messages.map((row) => parseMessage(row, chatId));
    if (items.some((row) => !row)) throw new MaxError(0, 'history_unknown', false);
    const rows = items as Message[];
    if (
      rows.some(
        (row) => row.sourceMs > upperMs || (lowerMs !== undefined && row.sourceMs < lowerMs),
      )
    )
      throw new MaxError(0, 'history_boundary_unknown', false);
    if (new Set(rows.map((row) => row.id)).size !== rows.length)
      throw new MaxError(0, 'history_duplicate', false);
    return rows.sort((a, b) => b.sourceMs - a.sourceMs || b.id.localeCompare(a.id));
  }
  async remove(chatId: string, messageId: string, before: () => Promise<void>): Promise<void> {
    const result = await this.request(
      'DELETE',
      `/messages?${new URLSearchParams({ message_id: messageId })}`,
      { chatDelete: chatId, before },
    );
    if (result.success !== true) throw new MaxError(200, 'delete_unconfirmed', true);
  }
  async presence(chatId: string, messageId: string): Promise<'present' | 'absent' | 'unknown'> {
    try {
      const result = await this.request('GET', `/messages/${encodeURIComponent(messageId)}`);
      const message = parseMessage(result, chatId) ?? parseMessage(result.message, chatId);
      return message?.id === messageId ? 'present' : 'unknown';
    } catch (error) {
      if (error instanceof MaxError && error.status === 404 && error.code === 'message.not.found')
        return 'absent';
      throw error;
    }
  }
  async subscribe(): Promise<void> {
    if (!this.config.webhookUrl) return;
    const identity = await this.request('GET', '/me');
    if (String(identity.user_id) !== this.config.botId || identity.is_bot !== true)
      throw new Error('Configured Eraser bot identity does not match its token');
    const subscriptions = await this.request('GET', '/subscriptions');
    const list = subscriptions.subscriptions;
    if (!Array.isArray(list)) throw new Error('MAX subscriptions response unknown');
    if (
      list.some(
        (row) =>
          typeof record(row)?.url !== 'string' || record(row)?.url !== this.config.webhookUrl,
      )
    )
      throw new Error('Conflicting Eraser webhook subscription');
    const result = await this.request('POST', '/subscriptions', {
      body: {
        url: this.config.webhookUrl,
        secret: this.config.webhookSecret,
        update_types: [
          'message_created',
          'message_edited',
          'message_removed',
          'bot_added',
          'bot_removed',
        ],
      },
    });
    if (result.success !== true) throw new Error('MAX webhook subscription unconfirmed');
    const confirmed = await this.request('GET', '/subscriptions');
    if (
      !Array.isArray(confirmed.subscriptions) ||
      confirmed.subscriptions.length !== 1 ||
      record(confirmed.subscriptions[0])?.url !== this.config.webhookUrl
    )
      throw new Error('MAX webhook subscription readback unconfirmed');
  }
}
