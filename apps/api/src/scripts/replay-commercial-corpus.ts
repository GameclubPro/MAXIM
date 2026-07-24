import {
  replayCommercialCorpusFile,
  type CommercialCorpusReplaySummary,
} from './commercial-corpus-replay.util';

type CliOptions = {
  inputPath: string;
  manualOverlayPath?: string;
  diffOutputPath: string;
  summaryOutputPath?: string;
  includeExplanationOnly: boolean;
  includeUntrustedPlaceholderDiffs: boolean;
  overwrite: boolean;
  progressEvery: number;
};

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseNonNegativeInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return parsed;
}

export function readCommercialCorpusReplayCliOptions(argv: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let manualOverlayPath: string | undefined;
  let diffOutputPath: string | undefined;
  let summaryOutputPath: string | undefined;
  let includeExplanationOnly = false;
  let includeUntrustedPlaceholderDiffs = false;
  let overwrite = false;
  let progressEvery = 5000;
  const seenOptions = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (seenOptions.has(option)) {
      throw new Error(`${option} may be specified only once`);
    }
    seenOptions.add(option);
    const readValue = () => {
      const value = requireValue(argv, index, option);
      index += 1;
      return value;
    };
    switch (option) {
      case '--input':
        inputPath = readValue();
        break;
      case '--manual-overlay':
        manualOverlayPath = readValue();
        break;
      case '--output':
        diffOutputPath = readValue();
        break;
      case '--summary-output':
        summaryOutputPath = readValue();
        break;
      case '--include-explanation-only':
        includeExplanationOnly = true;
        break;
      case '--include-untrusted-placeholders':
        includeUntrustedPlaceholderDiffs = true;
        break;
      case '--overwrite':
        overwrite = true;
        break;
      case '--progress-every':
        progressEvery = parseNonNegativeInteger(readValue(), option);
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!inputPath || !diffOutputPath) {
    throw new Error(
      'Usage: npm run moderation:replay-commercial-corpus -- --input <corpus.jsonl> [--manual-overlay <overlay.jsonl>] --output <diff.jsonl> [--summary-output <summary.json>] [--include-explanation-only] [--include-untrusted-placeholders] [--overwrite] [--progress-every <n>]',
    );
  }
  return {
    inputPath,
    manualOverlayPath,
    diffOutputPath,
    summaryOutputPath,
    includeExplanationOnly,
    includeUntrustedPlaceholderDiffs,
    overwrite,
    progressEvery,
  };
}

export async function runCommercialCorpusReplay(
  argv: readonly string[],
): Promise<CommercialCorpusReplaySummary> {
  const options = readCommercialCorpusReplayCliOptions(argv);
  const summary = await replayCommercialCorpusFile({
    ...options,
    onProgress:
      options.progressEvery > 0
        ? (recordsProcessed) => {
            if (recordsProcessed % options.progressEvery === 0) {
              console.error(`commercial_corpus_replay_processed=${recordsProcessed}`);
            }
          }
        : undefined,
  });
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  void runCommercialCorpusReplay(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
