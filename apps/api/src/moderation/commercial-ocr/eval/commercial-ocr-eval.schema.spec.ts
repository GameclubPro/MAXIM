import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  commercialOcrEvalManifestSchema,
  loadCommercialOcrEvalManifest,
  readVerifiedCommercialOcrEvalImage,
} from './commercial-ocr-eval.schema';

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('commercial OCR eval corpus schema', () => {
  it('requires opaque unique case ids and immutable image digests', () => {
    const manifest = {
      schemaVersion: 1,
      corpusId: 'public-smoke',
      corpusRevision: 'v1',
      cases: [
        {
          id: 'safe-1',
          clusterId: 'safe-cluster-1',
          language: 'ru',
          category: 'safe-context',
          expectedAction: 'NO_ACTION',
          caption: '',
          images: [{ path: 'safe.png', sha256: 'a'.repeat(64) }],
        },
      ],
    };

    expect(commercialOcrEvalManifestSchema.parse(manifest)).toEqual(manifest);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [...manifest.cases, manifest.cases[0]],
      }),
    ).toThrow(/duplicate id/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...manifest,
        cases: [
          ...manifest.cases,
          { ...manifest.cases[0], id: 'unsafe-1', expectedAction: 'DELETE' },
        ],
      }),
    ).toThrow(/cluster contains conflicting expected actions/u);
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//u);
  });

  it('accepts legacy v1 cases while validating optional enforcement metadata', () => {
    const legacy = validManifest();
    expect(commercialOcrEvalManifestSchema.parse(legacy)).toEqual(legacy);

    const labeled = {
      ...legacy,
      cases: [
        {
          ...legacy.cases[0],
          imageTextScript: 'cyrillic_only',
          captionLanguage: 'none',
          hardNegativeCategory: 'rules_or_moderation_context',
        },
      ],
    };
    expect(commercialOcrEvalManifestSchema.parse(labeled)).toEqual(labeled);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], expectedAction: 'DELETE' }],
      }),
    ).toThrow(/hard-negative category requires NO_ACTION/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], caption: 'Текст', captionLanguage: 'none' }],
      }),
    ).toThrow(/non-empty caption cannot use none language/u);
    expect(() =>
      commercialOcrEvalManifestSchema.parse({
        ...labeled,
        cases: [{ ...labeled.cases[0], captionLanguage: 'ru' }],
      }),
    ).toThrow(/empty caption requires none language/u);
  });

  it('refuses traversal and digest drift before evaluation', async () => {
    const root = await temporaryRoot();
    const bytes = Buffer.from('fixture');
    await writeFile(join(root, 'fixture.bin'), bytes);

    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: {
          path: 'fixture.bin',
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
        maxBytes: 100,
      }),
    ).resolves.toEqual(bytes);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: '../fixture.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/escapes/u);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'fixture.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/digest mismatch/u);
  });

  it('rejects oversized files from metadata and symlinks that escape the canonical corpus root', async () => {
    const root = await temporaryRoot();
    const outsideRoot = await temporaryRoot();
    const oversizedPath = join(root, 'oversized.bin');
    const outsidePath = join(outsideRoot, 'outside.bin');
    await writeFile(oversizedPath, 'x');
    await truncate(oversizedPath, 101);
    await writeFile(outsidePath, 'outside');
    await symlink(outsidePath, join(root, 'linked.bin'));

    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'oversized.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/size/u);
    await expect(
      readVerifiedCommercialOcrEvalImage({
        corpusRoot: root,
        image: { path: 'linked.bin', sha256: 'a'.repeat(64) },
        maxBytes: 100,
      }),
    ).rejects.toThrow(/symlink escapes/u);
  });

  it('stats an oversized manifest before reading its contents', async () => {
    const root = await temporaryRoot();
    const manifestPath = join(root, 'manifest.json');
    await writeFile(manifestPath, '{}');
    await truncate(manifestPath, 16 * 1024 * 1024 + 1);

    await expect(loadCommercialOcrEvalManifest(manifestPath)).rejects.toThrow(/size/u);
  });

  it('requires an in-repository private corpus directory to be explicitly ignored', async () => {
    const repositoryRoot = await temporaryRoot();
    await execFileAsync('git', ['init', '--quiet'], { cwd: repositoryRoot });
    const publicRoot = join(repositoryRoot, 'public-corpus');
    const privateRoot = join(repositoryRoot, 'private-corpus');
    const trackedRoot = join(repositoryRoot, 'tracked-corpus');
    await Promise.all([mkdir(publicRoot), mkdir(privateRoot), mkdir(trackedRoot)]);
    await writeFile(join(repositoryRoot, '.gitignore'), 'private-corpus/\ntracked-corpus/\n');
    const manifest = JSON.stringify(validManifest());
    await Promise.all([
      writeFile(join(publicRoot, 'manifest.json'), manifest),
      writeFile(join(privateRoot, 'manifest.json'), manifest),
      writeFile(join(trackedRoot, 'manifest.json'), manifest),
    ]);
    await execFileAsync('git', ['add', '--force', 'tracked-corpus/manifest.json'], {
      cwd: repositoryRoot,
    });

    await expect(loadCommercialOcrEvalManifest(join(publicRoot, 'manifest.json'))).rejects.toThrow(
      /outside Git or under an ignored directory/u,
    );
    await expect(
      loadCommercialOcrEvalManifest(join(privateRoot, 'manifest.json')),
    ).resolves.toMatchObject({ manifest: validManifest(), corpusRoot: privateRoot });
    await expect(loadCommercialOcrEvalManifest(join(trackedRoot, 'manifest.json'))).rejects.toThrow(
      /Git-tracked files/u,
    );
  });

  it('fails closed when Git privacy verification itself is broken', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, '.git'), 'not a valid gitfile');
    await writeFile(join(root, 'manifest.json'), JSON.stringify(validManifest()));

    await expect(loadCommercialOcrEvalManifest(join(root, 'manifest.json'))).rejects.toThrow(
      /Unable to verify/u,
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'commercial-ocr-eval-'));
  temporaryRoots.push(root);
  return root;
}

function validManifest() {
  return {
    schemaVersion: 1 as const,
    corpusId: 'private-eval',
    corpusRevision: 'v1',
    cases: [
      {
        id: 'case-1',
        clusterId: 'cluster-1',
        language: 'ru' as const,
        category: 'test',
        expectedAction: 'NO_ACTION' as const,
        caption: '',
        images: [{ path: 'fixture.bin', sha256: 'a'.repeat(64) }],
      },
    ],
  };
}
