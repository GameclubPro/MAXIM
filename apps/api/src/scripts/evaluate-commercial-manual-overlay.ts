import {
  evaluateCommercialManualOverlay,
  type CommercialActionAdjudicationExpectation,
  type CommercialManualOverlayEvaluationSummary,
} from './commercial-manual-overlay-evaluator.util';

type CliOptions = {
  inputPath: string;
  overlayPath: string;
  actionAdjudicationPath?: string;
  actionAdjudicationExpected?: CommercialActionAdjudicationExpectation;
  allowPartialActionAdjudication: boolean;
  resultsOutputPath: string;
  summaryOutputPath?: string;
  overwrite: boolean;
};

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${option} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${option} must be a safe positive integer`);
  }
  return parsed;
}

export function readCommercialManualOverlayEvaluatorCliOptions(
  argv: readonly string[],
): CliOptions {
  let inputPath: string | undefined;
  let overlayPath: string | undefined;
  let actionAdjudicationPath: string | undefined;
  let actionAdjudicationSha256: string | undefined;
  let actionAdjudicationRecords: string | undefined;
  let actionAdjudicationInstances: string | undefined;
  let allowPartialActionAdjudication = false;
  let resultsOutputPath: string | undefined;
  let summaryOutputPath: string | undefined;
  let overwrite = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const readOnce = (current: string | undefined) => {
      if (current) {
        throw new Error(`${option} may be specified only once`);
      }
      const value = requireValue(argv, index, option);
      index += 1;
      return value;
    };
    switch (option) {
      case '--input':
        inputPath = readOnce(inputPath);
        break;
      case '--overlay':
        overlayPath = readOnce(overlayPath);
        break;
      case '--action-adjudication':
        actionAdjudicationPath = readOnce(actionAdjudicationPath);
        break;
      case '--action-adjudication-sha256':
        actionAdjudicationSha256 = readOnce(actionAdjudicationSha256);
        break;
      case '--action-adjudication-records':
        actionAdjudicationRecords = readOnce(actionAdjudicationRecords);
        break;
      case '--action-adjudication-instances':
        actionAdjudicationInstances = readOnce(actionAdjudicationInstances);
        break;
      case '--allow-partial-action-adjudication':
        allowPartialActionAdjudication = true;
        break;
      case '--output':
        resultsOutputPath = readOnce(resultsOutputPath);
        break;
      case '--summary-output':
        summaryOutputPath = readOnce(summaryOutputPath);
        break;
      case '--overwrite':
        overwrite = true;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!inputPath || !overlayPath || !resultsOutputPath) {
    throw new Error(
      'Usage: npm run moderation:evaluate-commercial-manual-overlay -- --input <corpus.jsonl> --overlay <manual-overlay.jsonl> [--action-adjudication <action-adjudication.tsv> (--action-adjudication-sha256 <sha256> --action-adjudication-records <n> --action-adjudication-instances <n> | --allow-partial-action-adjudication)] --output <results.jsonl> [--summary-output <summary.json>] [--overwrite]',
    );
  }
  const expectationValues = [
    actionAdjudicationSha256,
    actionAdjudicationRecords,
    actionAdjudicationInstances,
  ];
  const suppliedExpectationValues = expectationValues.filter(
    (value): value is string => value !== undefined,
  ).length;
  if (suppliedExpectationValues !== 0 && suppliedExpectationValues !== expectationValues.length) {
    throw new Error(
      'Action adjudication identity gate requires sha256, records, and instances together',
    );
  }
  if (suppliedExpectationValues > 0 && !actionAdjudicationPath) {
    throw new Error('Action adjudication identity gate requires --action-adjudication');
  }
  if (allowPartialActionAdjudication && !actionAdjudicationPath) {
    throw new Error('--allow-partial-action-adjudication requires --action-adjudication');
  }
  if (
    actionAdjudicationPath &&
    suppliedExpectationValues === 0 &&
    !allowPartialActionAdjudication
  ) {
    throw new Error(
      '--action-adjudication requires its frozen identity gate or --allow-partial-action-adjudication',
    );
  }
  if (allowPartialActionAdjudication && suppliedExpectationValues > 0) {
    throw new Error(
      '--allow-partial-action-adjudication cannot be combined with a frozen identity gate',
    );
  }
  const actionAdjudicationExpected =
    suppliedExpectationValues === expectationValues.length
      ? {
          sha256: actionAdjudicationSha256 as string,
          records: parsePositiveInteger(
            actionAdjudicationRecords as string,
            '--action-adjudication-records',
          ),
          instances: parsePositiveInteger(
            actionAdjudicationInstances as string,
            '--action-adjudication-instances',
          ),
        }
      : undefined;
  if (actionAdjudicationExpected && !/^[a-f0-9]{64}$/u.test(actionAdjudicationExpected.sha256)) {
    throw new Error('--action-adjudication-sha256 must be 64 lowercase hex characters');
  }
  return {
    inputPath,
    overlayPath,
    ...(actionAdjudicationPath ? { actionAdjudicationPath } : {}),
    ...(actionAdjudicationExpected ? { actionAdjudicationExpected } : {}),
    allowPartialActionAdjudication,
    resultsOutputPath,
    summaryOutputPath,
    overwrite,
  };
}

export async function runCommercialManualOverlayEvaluator(
  argv: readonly string[],
): Promise<CommercialManualOverlayEvaluationSummary> {
  const summary = await evaluateCommercialManualOverlay(
    readCommercialManualOverlayEvaluatorCliOptions(argv),
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  void runCommercialManualOverlayEvaluator(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
