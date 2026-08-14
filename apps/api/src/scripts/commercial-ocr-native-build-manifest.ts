import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createCommercialOcrNativeBuildManifest,
  probeCommercialOcrNativeArtifacts,
  resolveCommercialOcrNativeEngineConfig,
  serializeCommercialOcrNativeBuildManifest,
} from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';

const USAGE = 'Usage: --output <absolute-or-relative-path>';

export async function writeCommercialOcrNativeBuildManifest(outputPath: string): Promise<void> {
  if (
    typeof outputPath !== 'string' ||
    outputPath.length < 1 ||
    outputPath.length > 4_096 ||
    outputPath.includes('\0')
  ) {
    throw new Error(USAGE);
  }
  const artifacts = await probeCommercialOcrNativeArtifacts(
    resolveCommercialOcrNativeEngineConfig(),
  );
  const manifest = createCommercialOcrNativeBuildManifest(artifacts);
  await writeFile(resolve(outputPath), serializeCommercialOcrNativeBuildManifest(manifest), {
    encoding: 'utf8',
    mode: 0o444,
    flag: 'wx',
  });
}

function readOutputPath(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== '--output' || !argv[1]) {
    throw new Error(USAGE);
  }
  return argv[1];
}

async function main(): Promise<void> {
  await writeCommercialOcrNativeBuildManifest(readOutputPath(process.argv.slice(2)));
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
