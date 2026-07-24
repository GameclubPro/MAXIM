import {
  remapCommercialManualOverlay,
  type CommercialManualOverlayRemapSummary,
} from './commercial-manual-overlay-remap.util';

type CliOptions = {
  sourceInputPath: string;
  targetInputPath: string;
  overlayPath: string;
  outputPath: string;
  summaryOutputPath: string;
};

function requireValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function readCommercialManualOverlayRemapCliOptions(
  argv: readonly string[],
): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--source-input', '--target-input', '--overlay', '--output', '--summary-output'].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    if (values.has(option)) {
      throw new Error(`${option} may be specified only once`);
    }
    values.set(option, requireValue(argv, index, option));
    index += 1;
  }
  const sourceInputPath = values.get('--source-input');
  const targetInputPath = values.get('--target-input');
  const overlayPath = values.get('--overlay');
  const outputPath = values.get('--output');
  const summaryOutputPath = values.get('--summary-output');
  if (!sourceInputPath || !targetInputPath || !overlayPath || !outputPath || !summaryOutputPath) {
    throw new Error(
      'Usage: npm run moderation:remap-commercial-manual-overlay -- --source-input <source.jsonl> --target-input <target.jsonl> --overlay <overlay.jsonl> --output <remapped.jsonl> --summary-output <lineage.json>',
    );
  }
  return {
    sourceInputPath,
    targetInputPath,
    overlayPath,
    outputPath,
    summaryOutputPath,
  };
}

export async function runCommercialManualOverlayRemap(
  argv: readonly string[],
): Promise<CommercialManualOverlayRemapSummary> {
  const summary = await remapCommercialManualOverlay(
    readCommercialManualOverlayRemapCliOptions(argv),
  );
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  void runCommercialManualOverlayRemap(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
