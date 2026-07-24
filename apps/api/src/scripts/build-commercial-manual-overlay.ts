import {
  buildCommercialManualOverlay,
  type BuildCommercialManualOverlaySummary,
} from './commercial-manual-overlay.util';

type CliOptions = {
  inputPath: string;
  annotationPaths: string[];
  outputPath: string;
  overwrite: boolean;
};

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readCommercialManualOverlayCliOptions(argv: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let outputPath: string | undefined;
  const annotationPaths: string[] = [];
  let overwrite = false;

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case '--input':
        if (inputPath) {
          throw new Error('--input may be specified only once');
        }
        inputPath = requireValue(argv, index, option);
        index += 1;
        break;
      case '--annotations':
        annotationPaths.push(requireValue(argv, index, option));
        index += 1;
        break;
      case '--output':
        if (outputPath) {
          throw new Error('--output may be specified only once');
        }
        outputPath = requireValue(argv, index, option);
        index += 1;
        break;
      case '--overwrite':
        overwrite = true;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!inputPath || !outputPath || annotationPaths.length === 0) {
    throw new Error(
      'Usage: npm run moderation:build-commercial-manual-overlay -- --input <corpus.jsonl> --annotations <review.tsv> [--annotations <review.tsv> ...] --output <overlay.jsonl> [--overwrite]',
    );
  }
  return { inputPath, annotationPaths, outputPath, overwrite };
}

export async function runCommercialManualOverlayBuilder(
  argv: readonly string[],
): Promise<BuildCommercialManualOverlaySummary> {
  const summary = await buildCommercialManualOverlay(readCommercialManualOverlayCliOptions(argv));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  void runCommercialManualOverlayBuilder(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
