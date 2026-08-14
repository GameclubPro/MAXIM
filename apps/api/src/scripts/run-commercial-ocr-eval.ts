import { resolve } from 'node:path';
import {
  createCommercialOcrEvalCertificationRequest,
  type CommercialOcrEvalCertificationRequest,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval-certification';
import { evaluateCommercialOcrEvalGates } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-gates';
import { runCommercialOcrEval } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';
import type { CommercialOcrEvalReport } from '../moderation/commercial-ocr/eval/commercial-ocr-eval-runner';

export type CommercialOcrEvalCliOptions = {
  manifestPath: string;
  enforceGates: boolean;
  concurrency: number;
  immutableImageSha256?: string;
  sourceSha?: string;
  benchmarkEnvironmentSha256?: string;
  approvalKeyIdSha256?: string;
};

const USAGE =
  'Usage: --manifest <path> [--enforce-cyrillic-gates|--enforce-ru-gates] [--concurrency <1..4>] [--immutable-image-sha256 <64-hex>] [--source-sha <40-hex>] [--benchmark-environment-sha256 <64-hex>] [--approval-key-id-sha256 <64-hex>]';

export function readCommercialOcrEvalOptions(argv: readonly string[]): CommercialOcrEvalCliOptions {
  let manifestPath: string | null = null;
  let enforceGates = false;
  let concurrency = 1;
  let concurrencyProvided = false;
  let immutableImageSha256: string | undefined;
  let sourceSha: string | undefined;
  let benchmarkEnvironmentSha256: string | undefined;
  let approvalKeyIdSha256: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--manifest') {
      const value = argv[index + 1];
      if (manifestPath || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      manifestPath = resolve(value);
      index += 1;
      continue;
    }
    if (
      (argument === '--enforce-cyrillic-gates' || argument === '--enforce-ru-gates') &&
      !enforceGates
    ) {
      enforceGates = true;
      continue;
    }
    if (argument === '--concurrency') {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (
        concurrencyProvided ||
        !value ||
        value.startsWith('--') ||
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > 4
      ) {
        throw new Error(USAGE);
      }
      concurrency = parsed;
      concurrencyProvided = true;
      index += 1;
      continue;
    }
    if (argument === '--immutable-image-sha256') {
      const value = argv[index + 1];
      if (immutableImageSha256 || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      immutableImageSha256 = normalizeHex(value, 64);
      index += 1;
      continue;
    }
    if (argument === '--source-sha') {
      const value = argv[index + 1];
      if (sourceSha || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      sourceSha = normalizeHex(value, 40);
      index += 1;
      continue;
    }
    if (argument === '--benchmark-environment-sha256') {
      const value = argv[index + 1];
      if (benchmarkEnvironmentSha256 || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      benchmarkEnvironmentSha256 = normalizeHex(value, 64);
      index += 1;
      continue;
    }
    if (argument === '--approval-key-id-sha256') {
      const value = argv[index + 1];
      if (approvalKeyIdSha256 || !value || value.startsWith('--')) {
        throw new Error(USAGE);
      }
      approvalKeyIdSha256 = normalizeHex(value, 64);
      index += 1;
      continue;
    }
    throw new Error(USAGE);
  }
  if (!manifestPath) {
    throw new Error(USAGE);
  }
  if (
    enforceGates &&
    (!immutableImageSha256 || !sourceSha || !benchmarkEnvironmentSha256 || !approvalKeyIdSha256)
  ) {
    throw new Error(
      'Enforcement OCR eval requires --immutable-image-sha256, --source-sha, --benchmark-environment-sha256, and --approval-key-id-sha256 bindings',
    );
  }
  if (enforceGates && concurrency !== 1) {
    throw new Error('Enforcement OCR eval requires --concurrency 1 for performance certification');
  }
  return {
    manifestPath,
    enforceGates,
    concurrency,
    ...(immutableImageSha256 ? { immutableImageSha256 } : {}),
    ...(sourceSha ? { sourceSha } : {}),
    ...(benchmarkEnvironmentSha256 ? { benchmarkEnvironmentSha256 } : {}),
    ...(approvalKeyIdSha256 ? { approvalKeyIdSha256 } : {}),
  };
}

function normalizeHex(value: string, length: 40 | 64): string {
  const normalized = value.trim().toLowerCase();
  if (!new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(normalized)) {
    throw new Error(USAGE);
  }
  return normalized;
}

export function commercialOcrEvalExitCode(params: {
  report: CommercialOcrEvalReport;
  gates: Pick<ReturnType<typeof evaluateCommercialOcrEvalGates>, 'passed'> | null;
  enforceGates: boolean;
}): 0 | 2 {
  if (params.enforceGates) {
    return params.gates?.passed === true ? 0 : 2;
  }
  return params.report.failed > 0 ? 2 : 0;
}

export function createCommercialOcrEvalCliOutput(params: {
  report: CommercialOcrEvalReport;
  gates: ReturnType<typeof evaluateCommercialOcrEvalGates> | null;
  approvalKeyIdSha256?: string;
}): {
  report: CommercialOcrEvalReport;
  gates: ReturnType<typeof evaluateCommercialOcrEvalGates> | null;
  certificationRequest: CommercialOcrEvalCertificationRequest | null;
} {
  return {
    report: params.report,
    gates: params.gates,
    certificationRequest: params.gates?.passed
      ? createCommercialOcrEvalCertificationRequest({
          report: params.report,
          gates: params.gates,
          approvalKeyIdSha256: requireApprovalKeyId(params.approvalKeyIdSha256),
        })
      : null,
  };
}

function requireApprovalKeyId(value: string | undefined): string {
  if (!value) {
    throw new Error('Passing enforcement OCR gates require an Ed25519 approval key id');
  }
  return value;
}

async function main(): Promise<void> {
  const options = readCommercialOcrEvalOptions(process.argv.slice(2));
  const report = await runCommercialOcrEval({
    manifestPath: options.manifestPath,
    concurrency: options.concurrency,
    ...(options.immutableImageSha256 ? { immutableImageSha256: options.immutableImageSha256 } : {}),
    ...(options.sourceSha ? { sourceSha: options.sourceSha } : {}),
    ...(options.benchmarkEnvironmentSha256
      ? { expectedBenchmarkEnvironmentSha256: options.benchmarkEnvironmentSha256 }
      : {}),
  });
  const gates = options.enforceGates ? evaluateCommercialOcrEvalGates(report) : null;
  process.stdout.write(
    `${JSON.stringify(
      createCommercialOcrEvalCliOutput({
        report,
        gates,
        ...(options.approvalKeyIdSha256
          ? { approvalKeyIdSha256: options.approvalKeyIdSha256 }
          : {}),
      }),
    )}\n`,
  );
  process.exitCode = commercialOcrEvalExitCode({
    report,
    gates,
    enforceGates: options.enforceGates,
  });
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
