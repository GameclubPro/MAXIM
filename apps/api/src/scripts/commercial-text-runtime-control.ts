import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { PrismaService } from '../prisma/prisma.service';
import { COMMERCIAL_INTENT_QUALITY_COHORT } from '../moderation/commercial/commercial-policy-cohorts';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../moderation/commercial-ocr/commercial-ocr-detector-source.generated';
import {
  CommercialTextRuntimePolicyService,
  commercialTextControlSchema,
  commercialTextDecisionVersionForCohorts,
} from '../moderation/commercial/commercial-text-runtime-policy.service';
import {
  validateCommercialTextHoldoutArtifact,
  validateCommercialTextQualityCompanionArtifacts,
} from './commercial-text-holdout-artifact';

export function parseCommercialTextControlOptions(argv: string[], now = Date.now()) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: 'boolean' },
      'expected-revision': { type: 'string' },
      mode: { type: 'string' },
      'chat-id': { type: 'string', multiple: true },
      cohort: { type: 'string', multiple: true },
      'ttl-hours': { type: 'string' },
      artifact: { type: 'string' },
      'reviewed-artifact-sha256': { type: 'string' },
      'companion-artifact': { type: 'string', multiple: true },
      'reviewed-companion-artifact-sha256': { type: 'string', multiple: true },
      'settings-profile-digest': { type: 'string' },
    },
  });
  const command = positionals[0];
  if (positionals.length !== 1 || !['get', 'set', 'off', 'baseline'].includes(command ?? ''))
    throw new Error(
      'Usage: get | off/baseline --expected-revision N [--apply] | set --mode shadow/canary/on --expected-revision N --ttl-hours 1..24 [--chat-id ID] [--cohort NAME --artifact FILE --reviewed-artifact-sha256 SHA --settings-profile-digest SHA [--companion-artifact FILE --reviewed-companion-artifact-sha256 SHA]...] [--apply]',
    );
  if (command === 'get') {
    if (Object.keys(values).length) throw new Error('get accepts no options');
    return { command: 'get' as const };
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(values['expected-revision'] ?? ''))
    throw new Error('Explicit revision required');
  const expectedRevision = Number(values['expected-revision']);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision >= Number.MAX_SAFE_INTEGER - 1)
    throw new Error('Invalid revision');
  const mode = command === 'set' ? values.mode : command;
  if (command === 'set' && !['shadow', 'canary', 'on'].includes(mode ?? ''))
    throw new Error('Invalid mode');
  const promotion = ['canary', 'on'].includes(mode ?? '') && !!values.cohort?.length;
  const lifetime = command === 'set' ? Number(values['ttl-hours']) : null;
  if (lifetime !== null && (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 24))
    throw new Error('Finite TTL from 1 to 24 hours required');
  if (
    command !== 'set' &&
    Object.keys(values).some((key) => !['apply', 'expected-revision'].includes(key))
  )
    throw new Error('off/baseline accept only revision and apply');
  if (values.cohort?.length && !promotion)
    throw new Error('Cohorts require canary/on and independent evidence');
  if (
    promotion &&
    (!values.artifact ||
      !/^[a-f0-9]{64}$/u.test(values['reviewed-artifact-sha256'] ?? '') ||
      !/^[a-f0-9]{64}$/u.test(values['settings-profile-digest'] ?? ''))
  )
    throw new Error(
      'Promotion requires frozen artifact, independently reviewed digest and exact settings profile',
    );
  if (
    !promotion &&
    (values.artifact ||
      values['reviewed-artifact-sha256'] ||
      values['settings-profile-digest'] ||
      values['companion-artifact'] ||
      values['reviewed-companion-artifact-sha256'])
  )
    throw new Error('Evidence accepts only a promotion command');
  const companionPaths = values['companion-artifact'] ?? [];
  const companionDigests = values['reviewed-companion-artifact-sha256'] ?? [];
  const qualityPromotion = promotion && values.cohort!.includes(COMMERCIAL_INTENT_QUALITY_COHORT);
  if (
    qualityPromotion &&
    (companionPaths.length < 1 ||
      companionPaths.length > 2 ||
      companionPaths.length !== companionDigests.length ||
      companionPaths.some((path) => !path.trim()) ||
      companionDigests.some((digest) => !/^[a-f0-9]{64}$/u.test(digest)) ||
      new Set([values.artifact, ...companionPaths]).size !== companionPaths.length + 1 ||
      new Set([values['reviewed-artifact-sha256'], ...companionDigests]).size !==
        companionDigests.length + 1)
  )
    throw new Error(
      'Intent quality promotion requires separately reviewed companion artifacts for BALANCED 45/65 and STRICT 38/55',
    );
  if (!qualityPromotion && (companionPaths.length || companionDigests.length))
    throw new Error('Companion evidence accepts only an intent quality promotion command');
  const control = commercialTextControlSchema.parse({
    version: 2,
    revision: expectedRevision + 1,
    mode,
    chatIds: values['chat-id'] ?? [],
    promotedPolicyCohorts: values.cohort ?? [],
    effectiveAt: new Date(now).toISOString(),
    expiresAt: lifetime === null ? null : new Date(now + lifetime * 3600000).toISOString(),
    detectorSourceSha256: promotion ? COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 : null,
    decisionVersion: promotion
      ? commercialTextDecisionVersionForCohorts(values.cohort ?? [])
      : null,
    holdoutArtifactSha256: values['reviewed-artifact-sha256'] ?? null,
    settingsProfileDigests: values['settings-profile-digest']
      ? [values['settings-profile-digest']]
      : [],
  });
  if (mode === 'canary' && !control.chatIds.length)
    throw new Error('Canary requires explicit chats');
  if (
    new Set(control.chatIds).size !== control.chatIds.length ||
    new Set(control.promotedPolicyCohorts).size !== control.promotedPolicyCohorts.length
  )
    throw new Error('Duplicate cohort');
  return {
    command: command as 'set' | 'off' | 'baseline',
    expectedRevision,
    control,
    apply: values.apply === true,
    artifactPath: values.artifact,
    companionArtifacts: companionPaths.map((path, index) => ({
      path,
      reviewedSha256: companionDigests[index]!,
    })),
  };
}

export async function runCommercialTextControlCommand(
  service: Pick<CommercialTextRuntimePolicyService, 'snapshot' | 'set'>,
  argv: string[],
) {
  const options = parseCommercialTextControlOptions(argv);
  const before = await service.snapshot();
  const status = {
    revision: before.revision,
    mode: before.control?.mode ?? 'baseline',
    chatCount: before.control?.chatIds.length ?? 0,
    promotedPolicyCohorts: before.control?.promotedPolicyCohorts ?? [],
    expiresAt: before.control?.expiresAt ?? null,
  };
  if (options.command === 'get') return { command: 'get', status };
  if (before.revision !== options.expectedRevision)
    throw new Error('Revision conflict; inspect get again');
  if (options.artifactPath) {
    const artifacts = [
      { path: options.artifactPath, reviewedSha256: options.control.holdoutArtifactSha256! },
      ...options.companionArtifacts,
    ];
    const values: unknown[] = [];
    for (const artifact of artifacts) {
      if ((await stat(artifact.path)).size > 64 * 1024 * 1024)
        throw new Error('Holdout artifact exceeds limit');
      const bytes = await readFile(artifact.path);
      if (
        bytes.length > 64 * 1024 * 1024 ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.reviewedSha256
      )
        throw new Error('Frozen artifact digest mismatch');
      values.push(JSON.parse(bytes.toString('utf8')) as unknown);
    }
    const expected = {
      detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
      decisionVersion: commercialTextDecisionVersionForCohorts(
        options.control.promotedPolicyCohorts,
      ),
      settingsProfileDigest: options.control.settingsProfileDigests[0]!,
    };
    const validation = options.control.promotedPolicyCohorts.includes(
      COMMERCIAL_INTENT_QUALITY_COHORT,
    )
      ? validateCommercialTextQualityCompanionArtifacts(values, expected)
      : validateCommercialTextHoldoutArtifact(values[0], expected);
    if (
      !validation.valid ||
      options.control.promotedPolicyCohorts.some(
        (cohort) => !validation.approvedCohorts.includes(cohort),
      )
    )
      throw new Error('Independent holdout quality/provenance gate failed');
    options.control.expiresAt = new Date(
      Math.min(
        Date.parse(options.control.expiresAt!),
        ...values.map((value) => Date.parse((value as { expiresAt: string }).expiresAt)),
      ),
    ).toISOString();
  }
  const proposed = {
    revision: options.control.revision,
    mode: options.control.mode,
    chatCount: options.control.chatIds.length,
    promotedPolicyCohorts: options.control.promotedPolicyCohorts,
    expiresAt: options.control.expiresAt,
  };
  if (!options.apply) return { command: options.command, preview: true, status, proposed };
  const result = await service.set(options.control, options.expectedRevision);
  if (!result.applied) throw new Error('Revision conflict; no change applied');
  return { command: options.command, applied: true, revision: result.revision };
}

async function main() {
  const argv = process.argv.slice(2);
  const options = parseCommercialTextControlOptions(argv);
  const prisma =
    options.command !== 'get' &&
    options.control.promotedPolicyCohorts.includes(COMMERCIAL_INTENT_QUALITY_COHORT)
      ? new PrismaService()
      : undefined;
  const redis = new RedisCounterService(new ConfigService(process.env));
  try {
    await prisma?.onModuleInit();
    process.stdout.write(
      `${JSON.stringify(await runCommercialTextControlCommand(new CommercialTextRuntimePolicyService(redis, prisma), argv))}\n`,
    );
  } finally {
    await redis.onModuleDestroy();
    await prisma?.onModuleDestroy();
  }
}
if (require.main === module)
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Commercial control failed'}\n`,
    );
    process.exitCode = 1;
  });
