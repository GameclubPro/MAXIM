export const COMMERCIAL_BENCHMARK_ATTEMPT_COUNT = 3;
export const COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS = 240_000;
export const COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV = 'COMMERCIAL_BENCHMARK_MEDIAN_GATE';
export const COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV = 'COMMERCIAL_BENCHMARK_WRAPPER_NONCE';
export const COMMERCIAL_BENCHMARK_PROFILE_ENV = 'COMMERCIAL_BENCHMARK_PROFILE';
export const COMMERCIAL_BENCHMARK_REPORT_PREFIX = 'MAXIM_COMMERCIAL_BENCHMARK_RESULT=';
export const COMMERCIAL_BENCHMARK_GITHUB_HOSTED_PROFILE = 'github-hosted';

export const COMMERCIAL_BENCHMARK_LOCAL_LIMITS = {
  hotPath: {
    p95Ms: 6.25,
    p99Ms: 15,
  },
  adversarial: {
    p95Ms: 75,
    p99Ms: 100,
  },
} as const;

export const COMMERCIAL_BENCHMARK_GITHUB_HOSTED_LIMITS = {
  hotPath: {
    p95Ms: 10.5,
    p99Ms: 10.75,
  },
  adversarial: {
    p95Ms: 127,
    p99Ms: 128,
  },
} as const;

export type CommercialBenchmarkPercentiles = {
  p95Ms: number;
  p99Ms: number;
};

export type CommercialBenchmarkReport = {
  hotPath: CommercialBenchmarkPercentiles;
  adversarial: CommercialBenchmarkPercentiles;
};

export type CommercialBenchmarkLimits = CommercialBenchmarkReport;

export type CommercialBenchmarkProfile = {
  name: typeof COMMERCIAL_BENCHMARK_GITHUB_HOSTED_PROFILE;
  limits: CommercialBenchmarkLimits;
};

export type CommercialBenchmarkGate = {
  passed: boolean;
  failures: string[];
};

export function isCommercialBenchmarkMedianGateEnabled(env: NodeJS.ProcessEnv): boolean {
  const gateNonce = env[COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV];
  const wrapperNonce = env[COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV];
  return Boolean(gateNonce && gateNonce.length >= 16 && gateNonce === wrapperNonce);
}

export function resolveCommercialBenchmarkProfile(
  env: NodeJS.ProcessEnv,
): CommercialBenchmarkProfile {
  const profile = env[COMMERCIAL_BENCHMARK_PROFILE_ENV];
  if (profile === COMMERCIAL_BENCHMARK_GITHUB_HOSTED_PROFILE) {
    return {
      name: COMMERCIAL_BENCHMARK_GITHUB_HOSTED_PROFILE,
      limits: COMMERCIAL_BENCHMARK_GITHUB_HOSTED_LIMITS,
    };
  }

  throw new Error(
    profile
      ? `Unsupported commercial benchmark profile: ${profile}`
      : `Missing required ${COMMERCIAL_BENCHMARK_PROFILE_ENV} for commercial benchmark wrapper`,
  );
}

export function parseCommercialBenchmarkReport(output: string): CommercialBenchmarkReport {
  const payloads = output.split(/\r?\n/u).flatMap((line) => {
    const markerIndex = line.indexOf(COMMERCIAL_BENCHMARK_REPORT_PREFIX);
    return markerIndex === -1
      ? []
      : [line.slice(markerIndex + COMMERCIAL_BENCHMARK_REPORT_PREFIX.length).trim()];
  });

  if (payloads.length !== 1) {
    throw new Error(
      `Expected exactly one commercial benchmark report, received ${payloads.length}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloads[0] ?? '');
  } catch {
    throw new Error('Commercial benchmark report is not valid JSON');
  }

  const report = readRecord(parsed, 'report');
  return {
    hotPath: readPercentiles(report.hotPath, 'hotPath'),
    adversarial: readPercentiles(report.adversarial, 'adversarial'),
  };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('Cannot calculate a median without values');
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Median values must be finite non-negative numbers');
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function aggregateCommercialBenchmarkReports(
  reports: readonly CommercialBenchmarkReport[],
): CommercialBenchmarkReport {
  if (reports.length === 0) {
    throw new Error('Cannot aggregate commercial benchmark reports without attempts');
  }

  return {
    hotPath: {
      p95Ms: median(reports.map((report) => report.hotPath.p95Ms)),
      p99Ms: median(reports.map((report) => report.hotPath.p99Ms)),
    },
    adversarial: {
      p95Ms: median(reports.map((report) => report.adversarial.p95Ms)),
      p99Ms: median(reports.map((report) => report.adversarial.p99Ms)),
    },
  };
}

export function evaluateCommercialBenchmarkGate(
  report: CommercialBenchmarkReport,
  limits: CommercialBenchmarkLimits,
): CommercialBenchmarkGate {
  const failures: string[] = [];
  checkMetric(failures, 'hotPath.p95Ms', report.hotPath.p95Ms, limits.hotPath.p95Ms);
  checkMetric(failures, 'hotPath.p99Ms', report.hotPath.p99Ms, limits.hotPath.p99Ms);
  checkMetric(failures, 'adversarial.p95Ms', report.adversarial.p95Ms, limits.adversarial.p95Ms);
  checkMetric(failures, 'adversarial.p99Ms', report.adversarial.p99Ms, limits.adversarial.p99Ms);

  return {
    passed: failures.length === 0,
    failures,
  };
}

function readPercentiles(value: unknown, label: string): CommercialBenchmarkPercentiles {
  const record = readRecord(value, label);
  return {
    p95Ms: readMetric(record.p95Ms, `${label}.p95Ms`),
    p99Ms: readMetric(record.p99Ms, `${label}.p99Ms`),
  };
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Commercial benchmark ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readMetric(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Commercial benchmark ${label} must be a finite non-negative number`);
  }
  return value;
}

function checkMetric(failures: string[], label: string, actual: number, limit: number): void {
  if (actual > limit) {
    failures.push(`${label} ${actual.toFixed(3)}ms exceeds ${limit.toFixed(3)}ms`);
  }
}
