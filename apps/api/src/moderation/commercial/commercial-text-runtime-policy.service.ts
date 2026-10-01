import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ChatSettings } from '../../prisma/prisma-client';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { RedisCounterService } from '../redis-counter.service';

export const COMMERCIAL_TEXT_CONTROL_KEY = 'commercial-text:runtime-control:v1';
export const COMMERCIAL_TEXT_POLICY_COHORTS = [
  'owned-service-contrast-v1',
  'sliding-campaign-v1',
] as const;
export const commercialTextControlSchema = z
  .object({
    version: z.literal(2),
    revision: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER - 1),
    mode: z.enum(['baseline', 'shadow', 'canary', 'on', 'off']),
    chatIds: z.array(z.string().min(1).max(100)).max(1000),
    promotedPolicyCohorts: z.array(z.enum(COMMERCIAL_TEXT_POLICY_COHORTS)).max(2),
    detectorSourceSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
    decisionVersion: z.string().min(1).max(100).nullable().default(null),
    holdoutArtifactSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .default(null),
    settingsProfileDigests: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .max(10)
      .default([]),
    effectiveAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  })
  .strict();
export type CommercialTextControl = z.infer<typeof commercialTextControlSchema>;
export type CommercialTextAuthority = {
  revision: number;
  baselineAllowed: boolean;
  promotedPolicyCohorts: readonly string[];
  mode: CommercialTextControl['mode'] | 'unavailable';
};

@Injectable()
export class CommercialTextRuntimePolicyService {
  constructor(private readonly redis: RedisCounterService) {}

  async snapshot(): Promise<{ revision: number; control: CommercialTextControl | null }> {
    const [raw, revisionRaw] = await raceWithTimeout({
      operation: Promise.all([
        this.redis.getString(COMMERCIAL_TEXT_CONTROL_KEY),
        this.redis.getString(`${COMMERCIAL_TEXT_CONTROL_KEY}:revision`),
      ]),
      timeoutMs: 750,
      onTimeout: () => {
        throw new Error('Commercial text policy unavailable');
      },
    });
    const revision = revisionRaw === null ? 0 : Number(revisionRaw);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      (revisionRaw !== null && String(revision) !== revisionRaw)
    )
      throw new Error('Invalid commercial text policy revision');
    if (raw === null) return { revision, control: null };
    const control = commercialTextControlSchema.parse(JSON.parse(raw));
    if (control.revision !== revision)
      throw new Error('Commercial text policy changed during read');
    return { revision, control };
  }

  async authority(
    chatId: string,
    settingsProfileDigest?: string,
  ): Promise<CommercialTextAuthority> {
    try {
      const { revision, control } = await this.snapshot();
      if (!control || (control.expiresAt && Date.parse(control.expiresAt) <= Date.now()))
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_POLICY_COHORTS],
        };
      if (Date.parse(control.effectiveAt) > Date.now())
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_POLICY_COHORTS],
        };
      if (control.mode === 'baseline')
        return {
          revision,
          mode: 'baseline',
          baselineAllowed: true,
          promotedPolicyCohorts: [...COMMERCIAL_TEXT_POLICY_COHORTS],
        };
      const promoted =
        (control.mode === 'on' ||
          (control.mode === 'canary' && control.chatIds.includes(chatId))) &&
        control.detectorSourceSha256 === COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 &&
        control.decisionVersion === COMMERCIAL_ENGINE_CONFIG.decisionVersion &&
        control.holdoutArtifactSha256 !== null &&
        settingsProfileDigest !== undefined &&
        control.settingsProfileDigests.includes(settingsProfileDigest);
      return {
        revision,
        mode: control.mode,
        baselineAllowed: control.mode !== 'off',
        promotedPolicyCohorts: promoted ? control.promotedPolicyCohorts : [],
      };
    } catch {
      // FLAG: An unknown authority cannot authorize a delete, strike or sanction.
      return {
        revision: -1,
        mode: 'unavailable',
        baselineAllowed: false,
        promotedPolicyCohorts: [],
      };
    }
  }

  async set(control: CommercialTextControl, expectedRevision: number) {
    const parsed = commercialTextControlSchema.parse(control);
    const now = Date.now();
    if (parsed.revision !== expectedRevision + 1 || Date.parse(parsed.effectiveAt) > now + 30_000)
      throw new Error('Invalid commercial text control revision/time');
    if (parsed.mode === 'canary' && !parsed.chatIds.length)
      throw new Error('Canary requires an explicit chat cohort');
    if (new Set(parsed.chatIds).size !== parsed.chatIds.length)
      throw new Error('Duplicate commercial text chat cohort');
    if (
      parsed.promotedPolicyCohorts.length &&
      ['canary', 'on'].includes(parsed.mode) &&
      (parsed.detectorSourceSha256 !== COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 ||
        parsed.decisionVersion !== COMMERCIAL_ENGINE_CONFIG.decisionVersion ||
        !parsed.holdoutArtifactSha256 ||
        !parsed.settingsProfileDigests.length)
    )
      throw new Error('Promotion requires current detector and reviewed settings evidence');
    const expiry = parsed.expiresAt === null ? null : Date.parse(parsed.expiresAt);
    if (expiry === null && parsed.mode !== 'off' && parsed.mode !== 'baseline')
      throw new Error('Promotions require a finite lifetime');
    if (expiry !== null && (expiry <= now || expiry > now + 86_400_000))
      throw new Error('Commercial text control must expire within 24 hours');
    return this.redis.compareAndSetRevisionedControl({
      key: COMMERCIAL_TEXT_CONTROL_KEY,
      expectedRevision,
      value: JSON.stringify(parsed),
      expiresAtMs: expiry,
    });
  }
}

export function fingerprintCommercialTextSettingsProfile(
  settings: Pick<
    ChatSettings,
    'commercialAdsSensitivity' | 'commercialAdsWarnThreshold' | 'commercialAdsDeleteThreshold'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        settings.commercialAdsSensitivity,
        settings.commercialAdsWarnThreshold,
        settings.commercialAdsDeleteThreshold,
      ]),
    )
    .digest('hex');
}
