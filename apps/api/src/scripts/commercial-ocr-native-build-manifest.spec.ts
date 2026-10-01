import { readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as behavior from '../moderation/commercial-ocr/commercial-ocr-behavior-identity';
import { NATIVE_OCR_SANDBOX_PROTOCOL_VERSION } from '../moderation/commercial-ocr/native-ocr-sandbox.protocol';
import { writeCommercialOcrNativeBuildManifest } from './commercial-ocr-native-build-manifest';

const ARTIFACTS: behavior.CommercialOcrNativeArtifactSnapshot = {
  runtime: {
    nodeVersion: 'v24.16.0',
    platform: 'linux',
    architecture: 'x64',
    sharpVersion: '0.35.4',
    libvipsVersion: '8.18.3',
  },
  tesseract: {
    version: 'tesseract 5.5.2',
    binarySha256: '1'.repeat(64),
    availableLanguages: ['eng', 'rus'],
    traineddataSha256: { rus: '2'.repeat(64), eng: '3'.repeat(64) },
  },
};

describe('image-owned native OCR probe build artifact', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'maxim-native-probe-build-'));
    jest.spyOn(behavior, 'probeCommercialOcrNativeArtifacts').mockResolvedValue(ARTIFACTS);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('pins the complete native manifest and production controls in a read-only expectation', async () => {
    const manifestPath = join(directory, 'manifest.json');
    const probePath = join(directory, 'probe.json');
    await writeCommercialOcrNativeBuildManifest(manifestPath, probePath);
    const expected = behavior.resolveExpectedCommercialOcrProductionBehaviorIdentity(
      undefined,
      manifestPath,
    ).identity;
    expect(expected.complete).toBe(true);
    expect(expected.manifest.controls.maxQueue).toBe(4);
    expect(expected.manifest.controls.concurrency).toBe(1);
    expect(expected.manifest.controls.timeoutMs).toBe(10_000);
    expect(JSON.parse(readFileSync(probePath, 'utf8'))).toEqual({
      kind: 'commercial_ocr_native_probe_expectation',
      schemaVersion: 1,
      protocolVersion: NATIVE_OCR_SANDBOX_PROTOCOL_VERSION,
      fingerprintSha256: expected.fingerprintSha256,
    });
    expect(statSync(probePath).mode & 0o777).toBe(0o444);
    expect(statSync(manifestPath).mode & 0o777).toBe(0o444);
  });

  it('does not overwrite an existing trusted expectation', async () => {
    const manifestPath = join(directory, 'manifest.json');
    const probePath = join(directory, 'probe.json');
    await writeCommercialOcrNativeBuildManifest(manifestPath, probePath);
    const original = readFileSync(probePath);
    await expect(
      writeCommercialOcrNativeBuildManifest(join(directory, 'second.json'), probePath),
    ).rejects.toThrow(/EEXIST/u);
    expect(readFileSync(probePath)).toEqual(original);
  });

  it('rejects incomplete native artifacts without producing a trusted expectation', async () => {
    jest.spyOn(behavior, 'probeCommercialOcrNativeArtifacts').mockResolvedValue({
      ...ARTIFACTS,
      tesseract: { ...ARTIFACTS.tesseract, traineddataSha256: { rus: '', eng: '' } },
    });
    const probePath = join(directory, 'probe.json');
    await expect(
      writeCommercialOcrNativeBuildManifest(join(directory, 'manifest.json'), probePath),
    ).rejects.toThrow();
    expect(() => readFileSync(probePath)).toThrow(/ENOENT/u);
  });
});
