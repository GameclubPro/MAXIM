import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  aggregateCommercialBenchmarkReports,
  COMMERCIAL_BENCHMARK_ATTEMPT_COUNT,
  COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS,
  COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV,
  COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV,
  evaluateCommercialBenchmarkGate,
  parseCommercialBenchmarkReport,
  resolveCommercialBenchmarkProfile,
  type CommercialBenchmarkReport,
} from './commercial-benchmark-ci.util';

const API_ROOT = resolve(__dirname, '../..');
const JEST_BINARY = require.resolve('jest/bin/jest');
const JEST_CONFIG = resolve(API_ROOT, 'jest.config.cjs');
const BENCHMARK_SPEC = resolve(API_ROOT, 'src/moderation/commercial-benchmark.spec.ts');

export function runCommercialBenchmarkCi(): void {
  const profile = resolveCommercialBenchmarkProfile(process.env);
  const reports: CommercialBenchmarkReport[] = [];
  process.stdout.write(
    `Commercial benchmark profile=${profile.name}, limits: ${formatReport(profile.limits)}\n`,
  );

  for (let attempt = 1; attempt <= COMMERCIAL_BENCHMARK_ATTEMPT_COUNT; attempt += 1) {
    process.stdout.write(
      `\nCommercial benchmark fresh-process attempt ${attempt}/${COMMERCIAL_BENCHMARK_ATTEMPT_COUNT}\n`,
    );
    const wrapperNonce = randomUUID();
    const result = spawnSync(
      process.execPath,
      [
        JEST_BINARY,
        '--config',
        JEST_CONFIG,
        '--runInBand',
        '--detectOpenHandles',
        '--runTestsByPath',
        BENCHMARK_SPEC,
      ],
      {
        cwd: API_ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          [COMMERCIAL_BENCHMARK_MEDIAN_GATE_ENV]: wrapperNonce,
          [COMMERCIAL_BENCHMARK_WRAPPER_NONCE_ENV]: wrapperNonce,
        },
        maxBuffer: 50 * 1024 * 1024,
        timeout: COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS,
      },
    );

    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    process.stdout.write(stdout);
    process.stderr.write(stderr);

    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      throw new Error(
        `Commercial benchmark attempt ${attempt} timed out after ${COMMERCIAL_BENCHMARK_ATTEMPT_TIMEOUT_MS}ms`,
      );
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status === null) {
      throw new Error(
        `Commercial benchmark attempt ${attempt} ended without an exit code${
          result.signal ? ` (signal ${result.signal})` : ''
        }`,
      );
    }
    if (result.status !== 0) {
      const exitDetail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
      throw new Error(`Commercial benchmark attempt ${attempt} failed with ${exitDetail}`);
    }

    const report = parseCommercialBenchmarkReport(`${stdout}\n${stderr}`);
    reports.push(report);
    process.stdout.write(`Attempt ${attempt}: ${formatReport(report)}\n`);
  }

  const medianReport = aggregateCommercialBenchmarkReports(reports);
  const gate = evaluateCommercialBenchmarkGate(medianReport, profile.limits);
  process.stdout.write(`\nCommercial benchmark median: ${formatReport(medianReport)}\n`);
  if (!gate.passed) {
    throw new Error(`Commercial benchmark median gate failed: ${gate.failures.join('; ')}`);
  }
  process.stdout.write('Commercial benchmark median gate passed\n');
}

function formatReport(report: CommercialBenchmarkReport): string {
  return [
    `hot p95=${report.hotPath.p95Ms.toFixed(3)}ms`,
    `hot p99=${report.hotPath.p99Ms.toFixed(3)}ms`,
    `adversarial p95=${report.adversarial.p95Ms.toFixed(3)}ms`,
    `adversarial p99=${report.adversarial.p99Ms.toFixed(3)}ms`,
  ].join(', ');
}

if (require.main === module) {
  try {
    runCommercialBenchmarkCi();
  } catch (error: unknown) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
