import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createCommercialOcrNativeBehaviorIdentity,
  createCommercialOcrNativeBuildManifest,
  probeCommercialOcrNativeArtifacts,
  readCommercialOcrNativeBuildManifest,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  serializeCommercialOcrNativeBuildManifest,
  type CommercialOcrNativeArtifactSnapshot,
  type CommercialOcrNativeEngineConfig,
  type CommercialOcrNativeProbeDependencies,
} from './commercial-ocr-behavior-identity';

const BINARY_BYTES = Buffer.from('reviewed-tesseract-binary');
const RUS_TRAINEDDATA_BYTES = Buffer.from('reviewed-rus-traineddata');
const ENG_TRAINEDDATA_BYTES = Buffer.from('reviewed-eng-traineddata');
const BUILD_MANIFEST_SHA256 = '9'.repeat(64);
const ENGINE: CommercialOcrNativeEngineConfig = {
  binary: 'tesseract',
  tessdataPrefix: '/models',
  ompThreadLimit: 1,
};
const CONTROLS = resolveCommercialOcrNativeRuntimeControls(
  resolveCommercialOcrProductionNativeConfigReader(),
);
const ARTIFACTS: CommercialOcrNativeArtifactSnapshot = {
  runtime: {
    nodeVersion: 'v24.16.0',
    platform: 'linux',
    architecture: 'x64',
    sharpVersion: '0.35.3',
    libvipsVersion: '8.18.3',
  },
  tesseract: {
    version: 'tesseract 5.5.2',
    binarySha256: sha256(BINARY_BYTES),
    availableLanguages: ['eng', 'rus'],
    traineddataSha256: {
      rus: sha256(RUS_TRAINEDDATA_BYTES),
      eng: sha256(ENG_TRAINEDDATA_BYTES),
    },
  },
};
type NativeExecFile = CommercialOcrNativeProbeDependencies['execFile'];

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('commercial OCR behavior identity', () => {
  it('normalizes object-key and language order into one stable fingerprint', () => {
    const reorderedControls = Object.fromEntries(
      Object.entries(CONTROLS).reverse(),
    ) as unknown as typeof CONTROLS;
    const reorderedArtifacts: CommercialOcrNativeArtifactSnapshot = {
      tesseract: {
        traineddataSha256: {
          eng: ARTIFACTS.tesseract.traineddataSha256.eng,
          rus: ARTIFACTS.tesseract.traineddataSha256.rus,
        },
        availableLanguages: ['rus', 'eng'],
        binarySha256: ARTIFACTS.tesseract.binarySha256,
        version: ARTIFACTS.tesseract.version,
      },
      runtime: {
        libvipsVersion: ARTIFACTS.runtime.libvipsVersion,
        sharpVersion: ARTIFACTS.runtime.sharpVersion,
        architecture: ARTIFACTS.runtime.architecture,
        platform: ARTIFACTS.runtime.platform,
        nodeVersion: ARTIFACTS.runtime.nodeVersion,
      },
    };

    expect(nativeIdentity(reorderedControls, reorderedArtifacts).fingerprintSha256).toBe(
      nativeIdentity().fingerprintSha256,
    );
  });

  it('binds every native artifact and runtime control to the fingerprint', () => {
    const baseline = nativeIdentity().fingerprintSha256;
    const artifactMutations: readonly CommercialOcrNativeArtifactSnapshot[] = [
      { ...ARTIFACTS, runtime: { ...ARTIFACTS.runtime, nodeVersion: 'v24.16.1' } },
      { ...ARTIFACTS, runtime: { ...ARTIFACTS.runtime, platform: 'freebsd' } },
      { ...ARTIFACTS, runtime: { ...ARTIFACTS.runtime, architecture: 'arm64' } },
      { ...ARTIFACTS, runtime: { ...ARTIFACTS.runtime, sharpVersion: '0.35.4' } },
      { ...ARTIFACTS, runtime: { ...ARTIFACTS.runtime, libvipsVersion: '8.18.4' } },
      {
        ...ARTIFACTS,
        tesseract: { ...ARTIFACTS.tesseract, version: 'tesseract 5.5.3' },
      },
      {
        ...ARTIFACTS,
        tesseract: { ...ARTIFACTS.tesseract, binarySha256: '1'.repeat(64) },
      },
      {
        ...ARTIFACTS,
        tesseract: { ...ARTIFACTS.tesseract, availableLanguages: ['eng', 'osd', 'rus'] },
      },
      {
        ...ARTIFACTS,
        tesseract: {
          ...ARTIFACTS.tesseract,
          traineddataSha256: {
            ...ARTIFACTS.tesseract.traineddataSha256,
            rus: '2'.repeat(64),
          },
        },
      },
      {
        ...ARTIFACTS,
        tesseract: {
          ...ARTIFACTS.tesseract,
          traineddataSha256: {
            ...ARTIFACTS.tesseract.traineddataSha256,
            eng: '3'.repeat(64),
          },
        },
      },
    ];
    for (const artifacts of artifactMutations) {
      expect(nativeIdentity(CONTROLS, artifacts).fingerprintSha256).not.toBe(baseline);
    }
    for (const [name, value] of Object.entries(CONTROLS)) {
      const controls = {
        ...CONTROLS,
        [name]: Number(value) + 1,
      } as unknown as typeof CONTROLS;
      expect(nativeIdentity(controls).fingerprintSha256).not.toBe(baseline);
    }
    expect(
      createCommercialOcrNativeBehaviorIdentity({
        controls: CONTROLS,
        artifacts: ARTIFACTS,
        buildManifestSha256: '4'.repeat(64),
      }).fingerprintSha256,
    ).not.toBe(baseline);
  });

  it('fails closed without executing Tesseract when the build manifest is absent or invalid', async () => {
    const directory = await temporaryDirectory();
    const execFile = jest.fn<ReturnType<NativeExecFile>, Parameters<NativeExecFile>>();
    const missing = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(undefined, {
      buildManifestPath: join(directory, 'missing.json'),
      dependencies: { execFile },
    });
    expect(missing).toMatchObject({
      verified: false,
      status: 'build_manifest_missing',
      mismatches: ['buildManifest'],
    });

    const invalidPath = join(directory, 'invalid.json');
    await writeFile(invalidPath, '{}', 'utf8');
    expect(readCommercialOcrNativeBuildManifest(invalidPath).status).toBe('invalid');
    const invalid = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(undefined, {
      buildManifestPath: invalidPath,
      dependencies: { execFile },
    });
    expect(invalid).toMatchObject({
      verified: false,
      status: 'build_manifest_invalid',
      mismatches: ['buildManifest'],
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('uses a secret-free environment and verifies the complete image inventory', async () => {
    const harness = probeHarness();
    const artifacts = await probeCommercialOcrNativeArtifacts(ENGINE, harness.dependencies);

    expect(artifacts).toEqual(ARTIFACTS);
    expect(harness.environments).toEqual([
      {
        PATH: '/safe/bin',
        LANG: 'ru_RU.UTF-8',
        LC_ALL: 'C.UTF-8',
        LD_LIBRARY_PATH: '/safe/lib',
        OMP_THREAD_LIMIT: '1',
        TESSDATA_PREFIX: '/models',
      },
      {
        PATH: '/safe/bin',
        LANG: 'ru_RU.UTF-8',
        LC_ALL: 'C.UTF-8',
        LD_LIBRARY_PATH: '/safe/lib',
        OMP_THREAD_LIMIT: '1',
        TESSDATA_PREFIX: '/models',
      },
    ]);
  });

  it('detects binary drift before execution and traineddata drift after probing', async () => {
    const directory = await temporaryDirectory();
    const manifestPath = join(directory, 'manifest.json');
    await writeFile(
      manifestPath,
      serializeCommercialOcrNativeBuildManifest(
        createCommercialOcrNativeBuildManifest(ARTIFACTS),
      ),
      'utf8',
    );

    const binaryDrift = probeHarness({ binaryBytes: Buffer.from('unreviewed-binary') });
    const binaryResult = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(undefined, {
      buildManifestPath: manifestPath,
      dependencies: binaryDrift.dependencies,
    });
    expect(binaryResult).toMatchObject({
      verified: false,
      status: 'mismatch',
      mismatches: ['tesseract.binarySha256'],
    });
    expect(binaryDrift.execFile).not.toHaveBeenCalled();

    const traineddataDrift = probeHarness({
      rusTraineddataBytes: Buffer.from('unreviewed-rus-traineddata'),
    });
    const traineddataResult = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(
      undefined,
      {
        buildManifestPath: manifestPath,
        dependencies: traineddataDrift.dependencies,
      },
    );
    expect(traineddataResult).toMatchObject({
      verified: false,
      status: 'mismatch',
      mismatches: ['tesseract.traineddataSha256.rus'],
    });
  });

  it('does not execute a modified binary even when the local manifest was modified with it', async () => {
    const directory = await temporaryDirectory();
    const manifestPath = join(directory, 'modified-manifest.json');
    const modifiedBinary = Buffer.from('modified-binary-and-local-manifest');
    await writeFile(
      manifestPath,
      serializeCommercialOcrNativeBuildManifest(
        createCommercialOcrNativeBuildManifest({
          ...ARTIFACTS,
          tesseract: {
            ...ARTIFACTS.tesseract,
            binarySha256: sha256(modifiedBinary),
          },
        }),
      ),
      'utf8',
    );
    const harness = probeHarness({ binaryBytes: modifiedBinary });

    const result = await resolveVerifiedCommercialOcrNativeBehaviorIdentity(undefined, {
      buildManifestPath: manifestPath,
      trustedBinarySha256: ARTIFACTS.tesseract.binarySha256,
      dependencies: harness.dependencies,
    });

    expect(result).toMatchObject({
      verified: false,
      status: 'mismatch',
      mismatches: ['tesseract.binarySha256'],
    });
    expect(harness.execFile).not.toHaveBeenCalled();
  });
});

function nativeIdentity(
  controls = CONTROLS,
  artifacts = ARTIFACTS,
) {
  return createCommercialOcrNativeBehaviorIdentity({
    controls,
    artifacts,
    buildManifestSha256: BUILD_MANIFEST_SHA256,
  });
}

function probeHarness(
  overrides: Readonly<{
    binaryBytes?: Buffer;
    rusTraineddataBytes?: Buffer;
    engTraineddataBytes?: Buffer;
  }> = {},
): Readonly<{
  dependencies: Partial<CommercialOcrNativeProbeDependencies>;
  execFile: jest.MockedFunction<NativeExecFile>;
  environments: NodeJS.ProcessEnv[];
}> {
  const binaryBytes = overrides.binaryBytes ?? BINARY_BYTES;
  const rusTraineddataBytes = overrides.rusTraineddataBytes ?? RUS_TRAINEDDATA_BYTES;
  const engTraineddataBytes = overrides.engTraineddataBytes ?? ENG_TRAINEDDATA_BYTES;
  const environments: NodeJS.ProcessEnv[] = [];
  const execFile = jest.fn<ReturnType<NativeExecFile>, Parameters<NativeExecFile>>(
    async (_binary, args, options) => {
      environments.push(options.env);
      return args[0] === '--version'
        ? { stdout: 'tesseract 5.5.2\n', stderr: '' }
        : {
            stdout: 'List of available languages in "/models" (2):\neng\nrus\n',
            stderr: '',
          };
    },
  );
  return {
    execFile,
    environments,
    dependencies: {
      execFile,
      readFile: async (pathname) => {
        if (pathname === '/safe/bin/tesseract') return binaryBytes;
        if (pathname.endsWith('/rus.traineddata')) return rusTraineddataBytes;
        if (pathname.endsWith('/eng.traineddata')) return engTraineddataBytes;
        throw new Error(`Unexpected native artifact path: ${pathname}`);
      },
      realpath: async (pathname) => pathname,
      access: async () => undefined,
      runtime: { nodeVersion: 'v24.16.0', platform: 'linux', architecture: 'x64' },
      sharpVersions: { sharp: '0.35.3', vips: '8.18.3' },
      environment: {
        PATH: '/safe/bin',
        LANG: 'ru_RU.UTF-8',
        LC_ALL: 'C.UTF-8',
        LD_LIBRARY_PATH: '/safe/lib',
        DATABASE_URL: 'must-not-leak',
        MAX_BOT_TOKEN: 'must-not-leak',
      },
      path: '/safe/bin',
      cwd: '/work',
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-ocr-identity-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
