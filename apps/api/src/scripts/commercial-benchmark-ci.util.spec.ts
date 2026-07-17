import {
  aggregateCommercialBenchmarkReports,
  COMMERCIAL_BENCHMARK_ATTEMPT_COUNT,
  COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS,
  COMMERCIAL_BENCHMARK_LIMITS,
  COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV,
  COMMERCIAL_BENCHMARK_REPORT_PREFIX,
  COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV,
  evaluateCommercialBenchmarkGate,
  isCommercialBenchmarkMedianGateEnabled,
  median,
  parseCommercialBenchmarkReport,
  type CommercialBenchmarkReport,
} from './commercial-benchmark-ci.util';

function report(values: {
  hotP95: number;
  hotP99: number;
  adversarialP95: number;
  adversarialP99: number;
}): CommercialBenchmarkReport {
  return {
    hotPath: { p95Ms: values.hotP95, p99Ms: values.hotP99 },
    adversarial: {
      p95Ms: values.adversarialP95,
      p99Ms: values.adversarialP99,
    },
  };
}

describe('commercial benchmark CI aggregation', () => {
  it('parses one machine-readable report from Jest output', () => {
    const expected = report({
      hotP95: 4.5,
      hotP99: 7.5,
      adversarialP95: 60,
      adversarialP99: 80,
    });
    const output = [
      'PASS src/moderation/commercial-benchmark.spec.ts',
      `  ${COMMERCIAL_BENCHMARK_REPORT_PREFIX}${JSON.stringify(expected)}`,
      'Tests: 7 passed, 7 total',
    ].join('\n');

    expect(parseCommercialBenchmarkReport(output)).toEqual(expected);
  });

  it.each([
    ['a missing report', 'PASS benchmark'],
    [
      'duplicate reports',
      `${COMMERCIAL_BENCHMARK_REPORT_PREFIX}{}\n${COMMERCIAL_BENCHMARK_REPORT_PREFIX}{}`,
    ],
    ['malformed JSON', `${COMMERCIAL_BENCHMARK_REPORT_PREFIX}{`],
    [
      'invalid metrics',
      `${COMMERCIAL_BENCHMARK_REPORT_PREFIX}${JSON.stringify(
        report({ hotP95: -1, hotP99: 7.5, adversarialP95: 60, adversarialP99: 80 }),
      )}`,
    ],
  ])('rejects %s', (_label, output) => {
    expect(() => parseCommercialBenchmarkReport(output)).toThrow();
  });

  it('uses the median so one slow runner attempt cannot move the gate', () => {
    const aggregated = aggregateCommercialBenchmarkReports([
      report({ hotP95: 4, hotP99: 8, adversarialP95: 55, adversarialP99: 82 }),
      report({ hotP95: 40, hotP99: 80, adversarialP95: 550, adversarialP99: 820 }),
      report({ hotP95: 5, hotP99: 9, adversarialP95: 60, adversarialP99: 88 }),
    ]);

    expect(aggregated).toEqual(
      report({ hotP95: 5, hotP99: 9, adversarialP95: 60, adversarialP99: 88 }),
    );
    expect(median([8, 2, 4, 6])).toBe(5);
  });

  it('requires the wrapper nonce handshake before deferring per-attempt assertions', () => {
    const nonce = 'c6e978a9-f3a7-4f6f-a921-53c52b24ec0e';

    expect(
      isCommercialBenchmarkMedianGateEnabled({
        [COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV]: nonce,
      }),
    ).toBe(false);
    expect(
      isCommercialBenchmarkMedianGateEnabled({
        [COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV]: nonce,
        [COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV]: 'different-wrapper-nonce',
      }),
    ).toBe(false);
    expect(
      isCommercialBenchmarkMedianGateEnabled({
        [COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV]: '1',
        [COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV]: '1',
      }),
    ).toBe(false);
    expect(
      isCommercialBenchmarkMedianGateEnabled({
        [COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV]: nonce,
        [COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV]: nonce,
      }),
    ).toBe(true);
  });

  it('keeps the original p95 and p99 budgets as the median gate', () => {
    expect(COMMERCIAL_BENCHMARK_ATTEMPT_COUNT).toBe(3);
    expect(COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS).toBe(240_000);
    expect(COMMERCIAL_BENCHMARK_LIMITS).toEqual({
      hotPath: { p95Ms: 6.25, p99Ms: 15 },
      adversarial: { p95Ms: 75, p99Ms: 100 },
    });

    const atLimits = report({
      hotP95: 6.25,
      hotP99: 15,
      adversarialP95: 75,
      adversarialP99: 100,
    });
    expect(evaluateCommercialBenchmarkGate(atLimits)).toEqual({ passed: true, failures: [] });

    const overLimits = report({
      hotP95: 6.251,
      hotP99: 15.001,
      adversarialP95: 75.001,
      adversarialP99: 100.001,
    });
    const gate = evaluateCommercialBenchmarkGate(overLimits);
    expect(gate.passed).toBe(false);
    expect(gate.failures).toHaveLength(4);
  });
});
