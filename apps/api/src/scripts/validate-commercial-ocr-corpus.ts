import { resolve } from 'node:path';
import {
  loadCommercialOcrEvalManifest,
  readVerifiedCommercialOcrEvalImage,
} from '../moderation/commercial-ocr/eval/commercial-ocr-eval.schema';

export function readCommercialOcrCorpusValidationOptions(argv: readonly string[]): {
  manifestPath: string;
} {
  if (argv.length !== 2 || argv[0] !== '--manifest' || !argv[1] || argv[1].startsWith('--')) {
    throw new Error('Usage: --manifest <path>');
  }
  return { manifestPath: resolve(argv[1]) };
}

export async function validateCommercialOcrCorpus(manifestPath: string): Promise<{
  ok: true;
  corpusId: string;
  cases: number;
}> {
  const loaded = await loadCommercialOcrEvalManifest(manifestPath);
  for (const fixture of loaded.manifest.cases) {
    for (const image of fixture.images) {
      await readVerifiedCommercialOcrEvalImage({
        corpusRoot: loaded.corpusRoot,
        image,
        maxBytes: 64 * 1024 * 1024,
      });
    }
  }
  return {
    ok: true,
    corpusId: loaded.manifest.corpusId,
    cases: loaded.manifest.cases.length,
  };
}

async function main(): Promise<void> {
  const options = readCommercialOcrCorpusValidationOptions(process.argv.slice(2));
  const result = await validateCommercialOcrCorpus(options.manifestPath);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
