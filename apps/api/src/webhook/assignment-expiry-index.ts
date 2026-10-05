// One indexed heap entry per chat: refreshes cannot accumulate stale expiry records.
export class AssignmentExpiryIndex {
  private readonly heap: Array<{ key: string; expiresAt: number }> = [];
  private readonly positions = new Map<string, number>();

  get size(): number {
    return this.heap.length;
  }

  set(key: string, expiresAt: number): void {
    this.delete(key);
    const index = this.heap.length;
    this.heap.push({ key, expiresAt });
    this.positions.set(key, index);
    this.up(index);
  }

  delete(key: string): void {
    const index = this.positions.get(key);
    if (index === undefined) return;
    this.positions.delete(key);
    const last = this.heap.pop()!;
    if (index === this.heap.length) return;
    this.heap[index] = last;
    this.positions.set(last.key, index);
    const moved = this.up(index);
    this.down(moved);
  }

  takeExpired(now: number, budget: number): string[] {
    const expired: string[] = [];
    while (expired.length < budget && this.heap[0] && this.heap[0].expiresAt <= now) {
      const key = this.heap[0].key;
      this.delete(key);
      expired.push(key);
    }
    return expired;
  }

  private swap(left: number, right: number): void {
    [this.heap[left], this.heap[right]] = [this.heap[right]!, this.heap[left]!];
    this.positions.set(this.heap[left]!.key, left);
    this.positions.set(this.heap[right]!.key, right);
  }

  private up(start: number): number {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent]!.expiresAt <= this.heap[index]!.expiresAt) break;
      this.swap(parent, index);
      index = parent;
    }
    return index;
  }

  private down(start: number): void {
    let index = start;
    while (index * 2 + 1 < this.heap.length) {
      const left = index * 2 + 1;
      const right = left + 1;
      const next =
        right < this.heap.length && this.heap[right]!.expiresAt < this.heap[left]!.expiresAt
          ? right
          : left;
      if (this.heap[index]!.expiresAt <= this.heap[next]!.expiresAt) break;
      this.swap(index, next);
      index = next;
    }
  }
}
