import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createCommercialOcrNativeBuildManifest,
  commercialOcrCompleteNativeBehaviorIdentitySchema,
  probeCommercialOcrNativeArtifacts,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  resolveCommercialOcrNativeEngineConfig,
  serializeCommercialOcrNativeBuildManifest,
} from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';
import { serializeNativeOcrSandboxProbeExpectation } from '../moderation/commercial-ocr/native-ocr-sandbox.probe';

const USAGE =
  'Usage: --output <absolute-or-relative-path> [--probe-output <absolute-or-relative-path>]';

export async function writeCommercialOcrNativeBuildManifest(
  outputPath: string,
  probeOutputPath?: string,
): Promise<void> {
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
  if (probeOutputPath !== undefined) {
    if (!probeOutputPath || probeOutputPath.length > 4_096 || probeOutputPath.includes('\0')) {
      throw new Error(USAGE);
    }
    const { identity } = resolveExpectedCommercialOcrProductionBehaviorIdentity(
      undefined,
      resolve(outputPath),
    );
    const completeIdentity = commercialOcrCompleteNativeBehaviorIdentitySchema.parse({
      fingerprintSha256: identity.fingerprintSha256,
      manifest: identity.manifest,
    });
    if (!identity.complete) throw new Error('Native OCR build probe identity is incomplete');
    await writeFile(
      resolve(probeOutputPath),
      serializeNativeOcrSandboxProbeExpectation(completeIdentity.fingerprintSha256),
      {
        encoding: 'utf8',
        mode: 0o444,
        flag: 'wx',
      },
    );
  }
}

function readOutputPaths(argv: readonly string[]): { output: string; probeOutput?: string } {
  if (
    (argv.length !== 2 && argv.length !== 4) ||
    argv[0] !== '--output' ||
    !argv[1] ||
    (argv.length === 4 && (argv[2] !== '--probe-output' || !argv[3]))
  ) {
    throw new Error(USAGE);
  }
  return { output: argv[1], ...(argv.length === 4 ? { probeOutput: argv[3] } : {}) };
}

async function main(): Promise<void> {
  const paths = readOutputPaths(process.argv.slice(2));
  await writeCommercialOcrNativeBuildManifest(paths.output, paths.probeOutput);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
