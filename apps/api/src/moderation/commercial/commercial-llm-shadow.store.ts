import { createHash } from 'node:crypto';
import { commercialReviewEvidenceMetadataSchema } from '@maxim/contracts/safety-desk';
import { Prisma, type CommercialReviewSample } from '../../prisma/prisma-client';
import type { PrismaClient, PrismaPoolConfig } from '../../prisma/prisma-client';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_VERSION,
  COMMERCIAL_LLM_POLICY_VERSION,
} from './commercial-llm.protocol';

export const COMMERCIAL_LLM_LOOKBACK_MS = 15 * 60_000;
export const COMMERCIAL_LLM_SCAN_LIMIT = 64;
export const COMMERCIAL_LLM_PRISMA_POOL = {
  max: 1,
  connectionTimeoutMillis: 750,
  idleTimeoutMillis: 10_000,
  statement_timeout: 1500,
  application_name: 'commercial-llm-shadow',
  options: '-c lock_timeout=1000 -c idle_in_transaction_session_timeout=2000',
} as const satisfies PrismaPoolConfig;
type Sample = Pick<
  CommercialReviewSample,
  'id' | 'source' | 'evidence' | 'qualityMetadata' | 'llmShadow' | 'expiresAt' | 'observedAt'
>;
export type ShadowCandidate = { id: string; excerpt: string; inputSha256: string };

function object(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// FLAG: Retained, complete TEXT samples are observations; no LLM result grants effect authority.
export function commercialLlmCandidate(row: Sample, now: Date): ShadowCandidate | null {
  const metadata = commercialReviewEvidenceMetadataSchema.safeParse(row.qualityMetadata);
  const excerpt = object(row.evidence).excerpt;
  if (
    row.source !== 'TEXT' ||
    !metadata.success ||
    metadata.data.analysisOutcome !== 'COMPLETE' ||
    metadata.data.sourceExcerptComplete !== true ||
    metadata.data.imageReviewRequired ||
    !metadata.data.logicalMessageKey ||
    !metadata.data.sourceSnapshotSha256 ||
    !metadata.data.settingsProfileDigest ||
    row.observedAt.getTime() < now.getTime() - COMMERCIAL_LLM_LOOKBACK_MS ||
    row.observedAt.getTime() > now.getTime() ||
    row.expiresAt.getTime() <= now.getTime() ||
    typeof excerpt !== 'string' ||
    !excerpt.trim() ||
    excerpt.length > 2500
  )
    return null;
  const inputSha256 = createHash('sha256')
    .update(
      JSON.stringify([
        metadata.data.logicalMessageKey,
        metadata.data.sourceSnapshotSha256,
        metadata.data.settingsProfileDigest,
        excerpt,
        COMMERCIAL_LLM_MODEL_SHA256,
        COMMERCIAL_LLM_PROMPT_SHA256,
        COMMERCIAL_LLM_RUNTIME_VERSION,
        COMMERCIAL_LLM_POLICY_VERSION,
      ]),
    )
    .digest('hex');
  return { id: row.id, excerpt, inputSha256 };
}

export class CommercialLlmShadowStore {
  constructor(private readonly prisma: Pick<PrismaClient, 'commercialReviewSample'>) {}

  async select(now = new Date()): Promise<{
    candidate: ShadowCandidate | null;
    scanned: number;
    ineligible: number;
    pageCapped: boolean;
  }> {
    // FLAG: Limit the indexed recent head BEFORE JSON eligibility; never walk retained history.
    const rows = await this.prisma.commercialReviewSample.findMany({
      where: {
        observedAt: { gte: new Date(now.getTime() - COMMERCIAL_LLM_LOOKBACK_MS), lte: now },
      },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: COMMERCIAL_LLM_SCAN_LIMIT,
      select: {
        id: true,
        source: true,
        evidence: true,
        qualityMetadata: true,
        llmShadow: true,
        expiresAt: true,
        observedAt: true,
      },
    });
    let ineligible = 0;
    let candidate: ShadowCandidate | null = null;
    for (const row of [...rows].reverse()) {
      const eligible = commercialLlmCandidate(row, now);
      if (!eligible) {
        ineligible += 1;
        continue;
      }
      if (!candidate && object(row.llmShadow).inputSha256 !== eligible.inputSha256)
        candidate = eligible;
    }
    return {
      candidate,
      scanned: rows.length,
      ineligible,
      pageCapped: rows.length === COMMERCIAL_LLM_SCAN_LIMIT,
    };
  }

  async persist(
    candidate: ShadowCandidate,
    observation: Prisma.InputJsonObject,
    valid: () => Promise<boolean> = async () => true,
  ): Promise<boolean> {
    // FLAG: Concurrent labels/execution enrichments remain intact; only the separate column changes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await valid())) return false;
      const row = await this.prisma.commercialReviewSample.findUnique({
        where: { id: candidate.id },
      });
      if (!row) return false;
      const current = commercialLlmCandidate(row, new Date());
      if (
        !current ||
        current.inputSha256 !== candidate.inputSha256 ||
        object(row.llmShadow).inputSha256 === candidate.inputSha256
      )
        return false;
      if (!(await valid())) return false;
      const changed = await this.prisma.commercialReviewSample.updateMany({
        where: {
          id: row.id,
          expiresAt: { gt: new Date() },
          qualityMetadata: { equals: row.qualityMetadata ?? Prisma.DbNull },
          evidence: { equals: row.evidence ?? Prisma.JsonNull },
          llmShadow: { equals: row.llmShadow ?? Prisma.DbNull },
        },
        data: {
          llmShadow: {
            ...observation,
            schemaVersion: 1,
            mode: 'SHADOW',
            inputSha256: candidate.inputSha256,
            observedAt: new Date().toISOString(),
          },
        },
      });
      if (changed.count === 1) return true;
    }
    return false;
  }
}
