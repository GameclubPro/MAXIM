import { createHash } from 'node:crypto';
import type { CommercialDetection } from './commercial-ad.detector';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';

type CacheableDetection = Omit<CommercialDetection, 'rawText' | 'analysisText'>;
type CacheRead = { hit: false } | { hit: true; detection: CacheableDetection | null };

// FLAG: Store only derived decisions and digests, never original/isolated message text.
export class CommercialDetectorDecisionCache {
  private readonly entries = new Map<string, CacheableDetection | null>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(private readonly maxEntries = 512) {}

  buildKey(input: unknown): string {
    return createHash('sha256')
      .update(COMMERCIAL_ENGINE_CONFIG.decisionVersion)
      .update(JSON.stringify(input))
      .digest('hex');
  }

  read(key: string): CacheRead {
    if (!this.entries.has(key)) {
      this.misses += 1;
      return { hit: false };
    }
    this.hits += 1;
    const cached = this.entries.get(key)!;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return { hit: true, detection: cached === null ? null : structuredClone(cached) };
  }

  remember(key: string, detection: CommercialDetection | null): void {
    // Isolated assertion text cannot be reconstructed from the source without parsing;
    // keep that path uncached instead of retaining contact-bearing text in a cache value.
    if (detection?.analysisText !== undefined || this.maxEntries <= 0) return;
    let cached: CacheableDetection | null = null;
    if (detection !== null) {
      const decision: Omit<CommercialDetection, 'rawText'> & { rawText?: string } = {
        ...detection,
      };
      delete decision.rawText;
      delete decision.analysisText;
      cached = structuredClone(decision);
    }
    this.entries.delete(key);
    this.entries.set(key, cached);
    if (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value!);
      this.evictions += 1;
    }
  }

  get stats(): { entries: number; hits: number; misses: number; evictions: number } {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
