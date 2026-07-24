import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { COMMERCIAL_ENGINE_CONFIG } from '../moderation/commercial/commercial-config';
import { COMMERCIAL_SECOND_STAGE_VERSION } from '../moderation/rule-engine-commercial-second-stage-cache';

const execFileAsync = promisify(execFile);
const DETECTOR_SUPPORT_FILES = [
  'apps/api/src/common/url-text.util.ts',
  'apps/api/src/moderation/commercial-campaign.util.ts',
  'apps/api/src/moderation/rule-engine-commercial-second-stage-cache.ts',
  'apps/api/src/moderation/rule-engine-commercial-thresholds.ts',
  'apps/api/src/moderation/rule-engine-detection-context.ts',
  'apps/api/src/moderation/rule-engine-normalization.ts',
] as const;

export type CommercialRunProvenance = {
  startedAt: string;
  git: {
    commit: string | null;
    dirty: boolean | null;
  };
  detector: {
    digestKind: 'SOURCE_FILES' | 'VERSION_DESCRIPTOR';
    sourceSha256: string;
    decisionVersion: string;
    patternPolicyVersion: string;
    classifierVersion: string;
  };
  auditTool: {
    digestKind: 'SOURCE_FILES' | 'VERSION_DESCRIPTOR';
    sourceSha256: string;
  };
  runtime: {
    nodeVersion: string;
  };
};

type DetectorDigest = Pick<CommercialRunProvenance['detector'], 'digestKind' | 'sourceSha256'>;
type AuditToolDigest = CommercialRunProvenance['auditTool'];

async function gitOutput(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function resolveGitRoot(cwd: string): Promise<string | null> {
  const root = await gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  return root ? resolve(root) : null;
}

function versionDescriptorDigest(scope: 'DETECTOR' | 'AUDIT_TOOL'): DetectorDigest {
  const descriptor = JSON.stringify({
    scope,
    decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
    patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
    classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
  });
  return {
    digestKind: 'VERSION_DESCRIPTOR',
    sourceSha256: createHash('sha256').update(descriptor).digest('hex'),
  };
}

export async function calculateCommercialDetectorSourceDigest(
  repositoryRoot: string,
): Promise<DetectorDigest> {
  const root = resolve(repositoryRoot);
  try {
    const commercialDirectory = resolve(root, 'apps/api/src/moderation/commercial');
    const commercialFiles = (await readdir(commercialDirectory))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'))
      .map((name) => resolve(commercialDirectory, name));
    const files = [
      ...commercialFiles,
      ...DETECTOR_SUPPORT_FILES.map((pathname) => resolve(root, pathname)),
    ].sort((left, right) => left.localeCompare(right));
    const hash = createHash('sha256');
    for (const pathname of files) {
      hash.update(relative(root, pathname));
      hash.update('\0');
      hash.update(await readFile(pathname));
      hash.update('\0');
    }
    return {
      digestKind: 'SOURCE_FILES',
      sourceSha256: hash.digest('hex'),
    };
  } catch {
    return versionDescriptorDigest('DETECTOR');
  }
}

export async function calculateCommercialAuditToolSourceDigest(
  repositoryRoot: string,
): Promise<AuditToolDigest> {
  const root = resolve(repositoryRoot);
  try {
    const scriptsDirectory = resolve(root, 'apps/api/src/scripts');
    const files = (await readdir(scriptsDirectory))
      .filter(
        (name) =>
          name.endsWith('.ts') &&
          !name.endsWith('.spec.ts') &&
          (name.startsWith('commercial-') ||
            /^(?:audit|build|evaluate|remap|replay|validate)-commercial-/u.test(name)),
      )
      .map((name) => resolve(scriptsDirectory, name))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) {
      throw new Error('Commercial audit tool sources were not found');
    }
    const hash = createHash('sha256');
    for (const pathname of files) {
      hash.update(relative(root, pathname));
      hash.update('\0');
      hash.update(await readFile(pathname));
      hash.update('\0');
    }
    return {
      digestKind: 'SOURCE_FILES',
      sourceSha256: hash.digest('hex'),
    };
  } catch {
    return versionDescriptorDigest('AUDIT_TOOL');
  }
}

export async function resolveCommercialRunProvenance(
  options: {
    startedAt?: string;
    repositoryRoot?: string;
  } = {},
): Promise<CommercialRunProvenance> {
  const startedAt = options.startedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(startedAt))) {
    throw new Error(`Invalid commercial run startedAt: ${startedAt}`);
  }
  const repositoryRoot = options.repositoryRoot
    ? resolve(options.repositoryRoot)
    : await resolveGitRoot(process.cwd());
  const commit = repositoryRoot ? await gitOutput(repositoryRoot, ['rev-parse', 'HEAD']) : null;
  const status = repositoryRoot
    ? await gitOutput(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
    : null;
  const [detectorDigest, auditToolDigest] = repositoryRoot
    ? await Promise.all([
        calculateCommercialDetectorSourceDigest(repositoryRoot),
        calculateCommercialAuditToolSourceDigest(repositoryRoot),
      ])
    : [versionDescriptorDigest('DETECTOR'), versionDescriptorDigest('AUDIT_TOOL')];

  return {
    startedAt: new Date(startedAt).toISOString(),
    git: {
      commit,
      dirty: status === null ? null : status.length > 0,
    },
    detector: {
      ...detectorDigest,
      decisionVersion: COMMERCIAL_ENGINE_CONFIG.decisionVersion,
      patternPolicyVersion: COMMERCIAL_ENGINE_CONFIG.patternPolicyVersion,
      classifierVersion: COMMERCIAL_SECOND_STAGE_VERSION,
    },
    auditTool: auditToolDigest,
    runtime: {
      nodeVersion: process.version,
    },
  };
}
