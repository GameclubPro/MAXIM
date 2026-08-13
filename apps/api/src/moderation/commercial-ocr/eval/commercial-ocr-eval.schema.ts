import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_EVAL_IMAGE_BYTES = 64 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const verifiedPrivateRoots = new Map<string, Promise<void>>();

export const commercialOcrEvalCaseSchema = z
  .object({
    id: z.string().regex(OPAQUE_ID_PATTERN),
    clusterId: z.string().regex(OPAQUE_ID_PATTERN),
    language: z.enum(['ru', 'en', 'mixed']),
    imageTextScript: z.enum(['cyrillic_only', 'latin_only', 'mixed', 'unknown']).optional(),
    captionLanguage: z.enum(['none', 'ru', 'en', 'mixed', 'other', 'unknown']).optional(),
    category: z.string().regex(OPAQUE_ID_PATTERN),
    hardNegativeCategory: z.string().regex(OPAQUE_ID_PATTERN).optional(),
    expectedAction: z.enum(['DELETE', 'NO_ACTION']),
    caption: z.string().max(8_000).default(''),
    images: z
      .array(
        z
          .object({
            path: z.string().min(1).max(512),
            sha256: z.string().regex(SHA256_PATTERN),
          })
          .strict(),
      )
      .min(1)
      .max(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hardNegativeCategory && value.expectedAction !== 'NO_ACTION') {
      context.addIssue({
        code: 'custom',
        path: ['hardNegativeCategory'],
        message: 'hard-negative category requires NO_ACTION',
      });
    }

    if (value.captionLanguage === undefined) {
      return;
    }
    const hasCaption = value.caption.trim().length > 0;
    if (hasCaption && value.captionLanguage === 'none') {
      context.addIssue({
        code: 'custom',
        path: ['captionLanguage'],
        message: 'non-empty caption cannot use none language',
      });
    }
    if (!hasCaption && value.captionLanguage !== 'none') {
      context.addIssue({
        code: 'custom',
        path: ['captionLanguage'],
        message: 'empty caption requires none language',
      });
    }
  });

export const commercialOcrEvalManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusId: z.string().regex(OPAQUE_ID_PATTERN),
    corpusRevision: z.string().regex(OPAQUE_ID_PATTERN),
    cases: z.array(commercialOcrEvalCaseSchema).min(1).max(100_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    const clusterLabels = new Map<string, CommercialOcrEvalCase['expectedAction']>();
    for (let index = 0; index < value.cases.length; index += 1) {
      const fixture = value.cases[index]!;
      const id = fixture.id;
      if (ids.has(id)) {
        context.addIssue({ code: 'custom', path: ['cases', index, 'id'], message: 'duplicate id' });
      }
      ids.add(id);
      const clusterLabel = clusterLabels.get(fixture.clusterId);
      if (clusterLabel && clusterLabel !== fixture.expectedAction) {
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'clusterId'],
          message: 'cluster contains conflicting expected actions',
        });
      }
      clusterLabels.set(fixture.clusterId, fixture.expectedAction);
    }
  });

export type CommercialOcrEvalManifest = z.infer<typeof commercialOcrEvalManifestSchema>;
export type CommercialOcrEvalCase = z.infer<typeof commercialOcrEvalCaseSchema>;

export async function loadCommercialOcrEvalManifest(
  manifestPath: string,
): Promise<{ manifest: CommercialOcrEvalManifest; manifestPath: string; corpusRoot: string }> {
  const requestedManifestPath = resolve(manifestPath);
  const requestedMetadata = await lstat(requestedManifestPath);
  if (!requestedMetadata.isFile()) {
    throw new Error('Commercial OCR eval manifest must be a regular file, not a symlink');
  }
  const canonicalManifestPath = await realpath(requestedManifestPath);
  const corpusRoot = dirname(canonicalManifestPath);
  await assertCommercialOcrCorpusRootPrivate(corpusRoot);
  const raw = await readBoundedRegularFile({
    pathname: canonicalManifestPath,
    maxBytes: MAX_MANIFEST_BYTES,
    label: 'Commercial OCR eval manifest',
    allowedRoot: corpusRoot,
  });
  const manifest = commercialOcrEvalManifestSchema.parse(JSON.parse(raw.toString('utf8')));
  return { manifest, manifestPath: canonicalManifestPath, corpusRoot };
}

export async function readVerifiedCommercialOcrEvalImage(params: {
  corpusRoot: string;
  image: CommercialOcrEvalCase['images'][number];
  maxBytes: number;
}): Promise<Buffer> {
  if (
    !Number.isSafeInteger(params.maxBytes) ||
    params.maxBytes < 1 ||
    params.maxBytes > MAX_EVAL_IMAGE_BYTES
  ) {
    throw new Error(`Commercial OCR eval maxBytes must be between 1 and ${MAX_EVAL_IMAGE_BYTES}`);
  }
  const canonicalRoot = await realpath(resolve(params.corpusRoot));
  await assertCommercialOcrCorpusRootPrivate(canonicalRoot);
  const imagePath = await resolveCorpusPath(canonicalRoot, params.image.path);
  const bytes = await readBoundedRegularFile({
    pathname: imagePath,
    maxBytes: params.maxBytes,
    label: 'Commercial OCR eval image',
    allowedRoot: canonicalRoot,
  });
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== params.image.sha256) {
    throw new Error('Commercial OCR eval image digest mismatch');
  }
  return bytes;
}

async function resolveCorpusPath(corpusRoot: string, requestedPath: string): Promise<string> {
  if (isAbsolute(requestedPath) || requestedPath.includes('\0')) {
    throw new Error('Commercial OCR eval image path must be relative');
  }
  const resolved = resolve(corpusRoot, requestedPath);
  assertPathContained(corpusRoot, resolved);
  const canonicalPath = await realpath(resolved);
  if (!isPathContained(corpusRoot, canonicalPath)) {
    throw new Error('Commercial OCR eval image symlink escapes the corpus root');
  }
  return canonicalPath;
}

function assertPathContained(root: string, pathname: string): void {
  if (!isPathContained(root, pathname)) {
    throw new Error('Commercial OCR eval image path escapes the corpus root');
  }
}

function isPathContained(root: string, pathname: string): boolean {
  const relativePath = relative(root, pathname);
  return !(
    relativePath.startsWith(`..${sep}`) ||
    relativePath === '..' ||
    isAbsolute(relativePath)
  );
}

async function readBoundedRegularFile(params: {
  pathname: string;
  maxBytes: number;
  label: string;
  allowedRoot: string;
}): Promise<Buffer> {
  const handle = await open(params.pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const openedPath = await resolveOpenedFilePath(handle, params.pathname, metadata);
    if (!isPathContained(params.allowedRoot, openedPath)) {
      throw new Error(`${params.label} resolves outside the corpus root`);
    }
    if (!metadata.isFile()) {
      throw new Error(`${params.label} must be a regular file`);
    }
    if (metadata.size < 1 || metadata.size > params.maxBytes) {
      throw new Error(`${params.label} size must be between 1 and ${params.maxBytes} bytes`);
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (true) {
      const remaining = params.maxBytes - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining + 1));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      totalBytes += bytesRead;
      if (totalBytes > params.maxBytes) {
        throw new Error(`${params.label} exceeds ${params.maxBytes} bytes`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (totalBytes < 1) {
      throw new Error(`${params.label} must not be empty`);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

async function resolveOpenedFilePath(
  handle: FileHandle,
  pathname: string,
  openedMetadata: Stats,
): Promise<string> {
  try {
    return await realpath(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      throw error;
    }
  }

  const [canonicalPath, currentMetadata] = await Promise.all([realpath(pathname), stat(pathname)]);
  if (openedMetadata.dev !== currentMetadata.dev || openedMetadata.ino !== currentMetadata.ino) {
    throw new Error('Commercial OCR eval file changed while it was being opened');
  }
  return canonicalPath;
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }
  return typeof error.code === 'string' ? error.code : null;
}

async function assertCommercialOcrCorpusRootPrivate(corpusRoot: string): Promise<void> {
  let verification = verifiedPrivateRoots.get(corpusRoot);
  if (!verification) {
    verification = verifyCommercialOcrCorpusRootPrivate(corpusRoot).catch((error: unknown) => {
      verifiedPrivateRoots.delete(corpusRoot);
      throw error;
    });
    verifiedPrivateRoots.set(corpusRoot, verification);
  }
  await verification;
}

async function verifyCommercialOcrCorpusRootPrivate(corpusRoot: string): Promise<void> {
  const repository = await runGit(corpusRoot, ['rev-parse', '--show-toplevel']);
  if (
    repository.exitCode === 128 &&
    /^fatal: not a git repository(?: \(or any of the parent directories\))?:/mu.test(
      repository.stderr,
    )
  ) {
    return;
  }
  if (repository.exitCode !== 0 || !repository.stdout.trim()) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is private');
  }
  const repositoryRoot = await realpath(repository.stdout.trim());
  if (!isPathContained(repositoryRoot, corpusRoot) || repositoryRoot === corpusRoot) {
    throw new Error('Commercial OCR eval corpus must be outside Git or under an ignored directory');
  }
  const repositoryPath = relative(repositoryRoot, corpusRoot);
  const tracked = await runGit(repositoryRoot, [
    '--literal-pathspecs',
    'ls-files',
    '--',
    repositoryPath,
  ]);
  if (tracked.exitCode !== 0) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is untracked');
  }
  if (tracked.stdout.length > 0) {
    throw new Error('Commercial OCR eval corpus contains Git-tracked files');
  }
  const ignored = await runGit(repositoryRoot, [
    'check-ignore',
    '--quiet',
    '--no-index',
    '--',
    `./${repositoryPath}`,
  ]);
  if (ignored.exitCode === 1) {
    throw new Error('Commercial OCR eval corpus must be outside Git or under an ignored directory');
  }
  if (ignored.exitCode !== 0) {
    throw new Error('Unable to verify that the Commercial OCR eval corpus is ignored');
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ exitCode: 0, stdout, stderr });
          return;
        }
        if (typeof error.code === 'number') {
          resolvePromise({ exitCode: error.code, stdout, stderr });
          return;
        }
        reject(error);
      },
    );
  });
}
