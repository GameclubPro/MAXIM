import {
  PROFANITY_PERFORMANCE_CORPUS,
  PROFANITY_SHOULD_ALLOW_CASES,
  PROFANITY_SHOULD_BLOCK_CASES,
} from './profanity-corpus.fixture';
import { RuleEngineService } from './rule-engine.service';

type ProfanityProbe = {
  hasProfanity(text: string): boolean;
};

function createProfanityProbe(): ProfanityProbe {
  return new RuleEngineService({} as never) as unknown as ProfanityProbe;
}

describe('profanity corpus', () => {
  const probe = createProfanityProbe();

  it.each(PROFANITY_SHOULD_BLOCK_CASES)('blocks abusive corpus case %#', (text) => {
    expect(probe.hasProfanity(text)).toBe(true);
  });

  it.each(PROFANITY_SHOULD_ALLOW_CASES)('allows safe corpus case %#', (text) => {
    expect(probe.hasProfanity(text)).toBe(false);
  });

  it('keeps profanity detection within the hot-path budget', () => {
    const sampleCount = 20_000;
    const budgetMs = Number(process.env.PROFANITY_PERF_BUDGET_MS ?? '0.5');
    const samples = Array.from(
      { length: sampleCount },
      (_, index) => PROFANITY_PERFORMANCE_CORPUS[index % PROFANITY_PERFORMANCE_CORPUS.length]!,
    );

    for (let index = 0; index < 1_000; index += 1) {
      probe.hasProfanity(samples[index % samples.length]!);
    }

    const startedAt = process.hrtime.bigint();
    let profanityHits = 0;
    for (const sample of samples) {
      if (probe.hasProfanity(sample)) {
        profanityHits += 1;
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const perMessageMs = elapsedMs / samples.length;

    expect(profanityHits).toBeGreaterThan(0);
    expect(perMessageMs).toBeLessThanOrEqual(budgetMs);
  });
});
