import {
  type WebhookPreparationScope,
  webhookPreparationScopeKey,
} from './webhook-preparation-scope';

export type DeferredScopeCursor = { id: string; createdAt: Date };
type Interval = { first: DeferredScopeCursor; last: DeferredScopeCursor };
export type DeferredScopeState = {
  key: string;
  scope: WebhookPreparationScope | null;
  current: Interval | null;
  after: DeferredScopeCursor | null;
  next: Interval | null;
  retained: Map<string, DeferredScopeCursor>;
};
export const DEFERRED_SCOPE_LIMIT = 32;
export const DEFERRED_SCOPE_IDENTITIES = 2;
const OVERFLOW_SCOPE = 'overflow';

function compare(left: DeferredScopeCursor, right: DeferredScopeCursor): number {
  return (
    left.createdAt.getTime() - right.createdAt.getTime() ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function include(interval: Interval | null, cursor: DeferredScopeCursor): Interval {
  return interval
    ? {
        first: compare(cursor, interval.first) < 0 ? cursor : interval.first,
        last: compare(cursor, interval.last) > 0 ? cursor : interval.last,
      }
    : { first: cursor, last: cursor };
}

// FLAG: Scan responsibility is scalar metadata, never payloads or execution authority.
// A full bot/class cannot consume the main discovery FIFO. Overflow identities stay
// covered by a finite interval until a bounded raw-page reader can retain them.
export class DeferredWebhookScopes {
  private readonly states = new Map<string, DeferredScopeState>();
  private readOffset = 0;
  private identityOffset = 0;

  capture(
    scope: WebhookPreparationScope | null,
    workUnitKey: string,
    cursor: DeferredScopeCursor,
  ): void {
    const requestedKey = scope ? webhookPreparationScopeKey(scope) : OVERFLOW_SCOPE;
    const key =
      this.states.has(requestedKey) || this.states.size < DEFERRED_SCOPE_LIMIT
        ? requestedKey
        : OVERFLOW_SCOPE;
    let state = this.states.get(key);
    if (!state) {
      state = {
        key,
        scope: key === OVERFLOW_SCOPE ? null : scope,
        current: null,
        after: null,
        next: null,
        retained: new Map(),
      };
      this.states.set(key, state);
    }
    if (state.retained.get(workUnitKey)?.id === cursor.id) return;
    // FLAG: A new hot retry must never rewind a scan already crossing older debt.
    // Finish its fixed interval first; merge additional captures into the next cycle.
    if (state.current) state.next = include(state.next, cursor);
    else state.current = include(state.current, cursor);
  }

  selectReaders(take: number): DeferredScopeState[] {
    const states = [...this.states.values()];
    if (!states.length) return [];
    const offset = this.readOffset % states.length;
    const ordered = [...states.slice(offset), ...states.slice(0, offset)];
    const selected: DeferredScopeState[] = [];
    let visited = 0;
    for (const state of ordered) {
      visited += 1;
      this.promote(state);
      if (state.current && state.retained.size < DEFERRED_SCOPE_IDENTITIES) selected.push(state);
      if (selected.length >= take) break;
    }
    this.readOffset = (offset + visited) % states.length;
    return selected;
  }

  retain(state: DeferredScopeState, workUnitKey: string, cursor: DeferredScopeCursor): boolean {
    const existing = state.retained.get(workUnitKey);
    if (existing) {
      if (existing.id !== cursor.id) {
        // FLAG: Coalescing a chat must not forget a different receipt when its
        // retained head changes or becomes terminal before actual admission.
        const later = compare(existing, cursor) <= 0 ? cursor : existing;
        if (later === existing) state.retained.set(workUnitKey, cursor);
        state.next = include(state.next, later);
      }
      return true;
    }
    if (state.retained.size >= DEFERRED_SCOPE_IDENTITIES) return false;
    state.retained.set(workUnitKey, cursor);
    return true;
  }

  advance(state: DeferredScopeState, after: DeferredScopeCursor | null, complete: boolean): void {
    if (after) state.after = after;
    if (complete) {
      state.current = null;
      state.after = null;
      this.promote(state);
    }
    this.prune(state);
  }

  identities(
    take: number,
  ): Array<{ key: string; id: string; scope: WebhookPreparationScope | null }> {
    const states = [...this.states.values()];
    if (!states.length) return [];
    const offset = this.identityOffset % states.length;
    const ordered = [...states.slice(offset), ...states.slice(0, offset)];
    const result: Array<{ key: string; id: string; scope: WebhookPreparationScope | null }> = [];
    // One identity per scope before any scope receives its second slot.
    for (let rank = 0; rank < DEFERRED_SCOPE_IDENTITIES && result.length < take; rank += 1)
      for (const state of ordered) {
        const item = [...state.retained.entries()][rank];
        if (item) result.push({ key: item[0], id: item[1].id, scope: state.scope });
        if (result.length >= take) break;
      }
    this.identityOffset = (offset + 1) % states.length;
    return result.slice(0, take);
  }

  release(workUnitKey: string, receiptId: string): void {
    for (const state of this.states.values()) {
      // FLAG: One chat can retain different receipts in different bot/class scopes.
      // Releasing one exact receipt must not consume another scope's responsibility.
      if (state.retained.get(workUnitKey)?.id === receiptId) state.retained.delete(workUnitKey);
      this.prune(state);
    }
  }

  private promote(state: DeferredScopeState): void {
    if (!state.current && state.next) {
      state.current = state.next;
      state.next = null;
      state.after = null;
    }
  }

  private prune(state: DeferredScopeState): void {
    if (!state.current && !state.next && state.retained.size === 0) this.states.delete(state.key);
  }

  snapshot(): { scopes: number; identities: number; intervals: number } {
    return {
      scopes: this.states.size,
      identities: [...this.states.values()].reduce(
        (count, state) => count + state.retained.size,
        0,
      ),
      intervals: [...this.states.values()].reduce(
        (count, state) => count + Number(!!state.current) + Number(!!state.next),
        0,
      ),
    };
  }
}
