import type { MaxUpdate } from '@maxim/contracts';
import { ConfigService } from '@nestjs/config';

import { ChatEntityType, WebhookStatus, type ChatSettings } from '../../prisma/prisma-client';
import type {
  CommercialOcrAdmissionActivationResult,
  CommercialOcrAdmissionSuppressionResult,
} from './commercial-ocr-admission.store';
import {
  COMMERCIAL_OCR_DECISION_POLICY_VERSION,
  evaluateCommercialOcrDecision,
  type CommercialOcrDecision,
  type CommercialOcrPass,
} from './commercial-ocr-decision-policy';
import {
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  parseCommercialOcrDeleteBinding,
} from './commercial-ocr-delete-guard.service';
import { CommercialOcrModerationService } from './commercial-ocr-moderation.service';
import { COMMERCIAL_OCR_JOB_SCHEMA_VERSION, type CommercialOcrJob } from './commercial-ocr.queue';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const jobId = 'commercial-image-ocr__fixture';
const activeDeadlineAtMs = Date.now() + 60_000;

type AnalysisFixture =
  | {
      kind: 'complete';
      decision: CommercialOcrDecision;
    }
  | {
      kind: 'incomplete';
      reason: string;
      imageIndex?: number;
      pass?: 'primary' | 'confirmation';
    }
  | { kind: 'retry'; reason: 'download_failed' | 'ocr_failed' };

type AccessFixture = {
  userId: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

type HarnessOptions = {
  mode?: 'on' | 'shadow';
  normalizedUpdate?: MaxUpdate;
  exactRows?: Array<Record<string, unknown> | null>;
  analysis?: AnalysisFixture;
  latches?: boolean[];
  admissionStates?: Array<'pending' | 'actionable' | 'observation'>;
  finalSettings?: ChatSettings;
  commitSettings?: ChatSettings;
  initialAdminUserIds?: string[];
  finalAdminUserIds?: string[];
  accessRows?: AccessFixture[];
  immunityResult?: 'granted' | 'not_granted';
  immunityError?: Error;
  runtimePolicies?: Array<{ enforce: boolean; controlExpiresAt?: string }>;
  governorDecision?: {
    action: 'run' | 'slow' | 'pause';
    retryAfterMs: number;
    reason: string;
  };
  governorError?: Error;
  webhookStatus?: WebhookStatus;
  webhookError?: Error;
  exactError?: Error;
  activationResult?: CommercialOcrAdmissionActivationResult;
  suppressionResult?: CommercialOcrAdmissionSuppressionResult;
  reservationTtlMs?: number;
};

describe('CommercialOcrModerationService', () => {
  it('does no work for a job whose absolute deadline already expired', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, Date.now() - 1),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.prisma.webhookEvent.findUnique).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'normalized source identity mismatch',
      options: { normalizedUpdate: update({ messageId: 'other-message' }) },
    },
    {
      label: 'incomplete normalized photo identity',
      options: { normalizedUpdate: update({ incompleteAttachment: true }) },
    },
    {
      label: 'exact source photo mismatch',
      options: { exactRows: [exactMessage({ photoId: 'other-photo' })] },
    },
    {
      label: 'exact source caption mismatch',
      options: { exactRows: [exactMessage({ caption: 'Changed before analysis' })] },
    },
    {
      label: 'incomplete exact stable photo identity',
      options: { exactRows: [exactMessage({ photoId: null })] },
    },
    {
      label: 'exact bot author',
      options: {
        exactRows: [exactMessage({ sender: { user_id: 'user-1', is_bot: true } })],
      },
    },
    {
      label: 'exact service author',
      options: {
        exactRows: [exactMessage({ sender: { user_id: 'user-1', type: 'service' } })],
      },
    },
    {
      label: 'unknown exact author kind',
      options: { exactRows: [exactMessage({ sender: { user_id: 'user-1' } })] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'fails open on $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it('suppresses intent creation when certified settings change after final authorization', async () => {
    const harness = buildHarness({
      commitSettings: settings({ commercialAdsDeleteThreshold: 66 }),
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(2);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'safe no-action decision',
      analysis: {
        kind: 'complete',
        decision: noActionDecision(['caption-safe-context:job_offer']),
      },
    },
    {
      label: 'incomplete OCR analysis',
      analysis: { kind: 'incomplete' as const, reason: 'ocr_failed' },
    },
    {
      label: 'terminal OCR timeout',
      analysis: { kind: 'incomplete' as const, reason: 'ocr_timeout' },
    },
  ] satisfies Array<{ label: string; analysis: AnalysisFixture }>)(
    'does not create an intent for $label',
    async ({ analysis }) => {
      const harness = buildHarness({ analysis });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
        analysis.kind === 'complete'
          ? 'analysis.complete.no_action'
          : `analysis.incomplete.${analysis.reason}`,
      );
      if (analysis.kind === 'incomplete') {
        const incompletePass = 'pass' in analysis ? analysis.pass : undefined;
        expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
          `analysis.incomplete.pass.${incompletePass ?? 'none'}`,
        );
      }
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it('runs shadow analysis without claiming or creating a delete intent', async () => {
    const harness = buildHarness({ mode: 'shadow', admissionStates: ['observation'] });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('analysis.complete.delete');
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('enforcement.suppressed.admission');
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('analyzes the canonical webhook caption after exact-source parity succeeds', async () => {
    const normalizedUpdate = update();
    const rawMessage = (normalizedUpdate.raw as { message: { body: Record<string, unknown> } })
      .message;
    rawMessage.body.forwarded_message = {
      body: {
        text: 'Forwarded offer',
      },
    };
    const exact = exactMessage();
    (exact.body as Record<string, unknown>).forwarded_message = {
      body: {
        text: 'Forwarded offer',
      },
    };
    const harness = buildHarness({
      mode: 'shadow',
      normalizedUpdate,
      exactRows: [exact],
      admissionStates: ['observation'],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({ caption: 'Buy now Forwarded offer' }),
    );
  });

  it('refreshes persisted photo URLs from the exact MAX row after stable source parity', async () => {
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: 'https://i.oneme.ru/stale-photo-url' }),
      exactRows: [exactMessage({ downloadUrl: 'https://i.oneme.ru/fresh-photo-url' })],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        album: expect.objectContaining({
          images: [
            {
              source: 'direct',
              photoId: 'photo-1',
              downloadUrl: 'https://i.oneme.ru/fresh-photo-url',
            },
          ],
        }),
      }),
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'enforcement.suppressed.source_url_fallback',
    );
  });

  it('analyzes a persisted URL fallback but never creates a delete intent from it', async () => {
    const persistedDownloadUrl = 'https://i.oneme.ru/persisted-photo-url';
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: persistedDownloadUrl }),
      exactRows: [exactMessage({ downloadUrl: null })],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        album: expect.objectContaining({
          images: [expect.objectContaining({ downloadUrl: persistedDownloadUrl })],
        }),
      }),
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'enforcement.suppressed.source_url_fallback',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('retries a non-retryable download failure when it used a persisted URL fallback', async () => {
    const harness = buildHarness({
      normalizedUpdate: update({ downloadUrl: 'https://i.oneme.ru/expired-photo-url' }),
      exactRows: [exactMessage({ downloadUrl: null })],
      analysis: { kind: 'incomplete', reason: 'download_failed', imageIndex: 0 },
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'retry', reason: 'download_failed' });

    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('analysis.retry.download_failed');
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'analysis.incomplete.download_failed',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('logs completed decisions at info level with privacy-safe structured fields only', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'complete',
        decision: {
          ...noActionDecision(['image-safe-context:0:request_or_recommendation']),
        },
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        imageCount: 1,
        rolloutMode: 'shadow',
        action: 'NO_ACTION',
        reasonCodes: ['image-safe-context:0:request_or_recommendation'],
      },
      'Commercial OCR decision completed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /Buy now|photo-1|i\.oneme\.ru|chat-1|message-1|user-1|event-1/u,
    );
  });

  it('logs incomplete analysis coverage without OCR text or source media', async () => {
    const harness = buildHarness({
      mode: 'shadow',
      admissionStates: ['observation'],
      analysis: {
        kind: 'incomplete' as const,
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
    });
    const log = jest.spyOn((harness.service as any).logger, 'log').mockImplementation(() => {});

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });

    expect(log).toHaveBeenCalledWith(
      {
        imageCount: 1,
        rolloutMode: 'shadow',
        outcome: 'INCOMPLETE',
        reason: 'ocr_truncated',
        imageIndex: 0,
        pass: 'primary',
      },
      'Commercial OCR analysis incomplete',
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /Buy now|photo-1|i\.oneme\.ru|chat-1|message-1|user-1|event-1/u,
    );
  });

  it('recovers a pending admission after durable webhook completion and exact source parity', async () => {
    const harness = buildHarness({
      admissionStates: ['pending', 'actionable'],
      reservationTtlMs: 420_000,
    });

    await expect(
      harness.service.processCommercialOcrJob(
        job({ actionEligible: false }),
        jobId,
        activeDeadlineAtMs,
      ),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(2);
    expect(harness.admissionStore.activate).toHaveBeenCalledWith({
      jobId,
      tombstoneTtlMs: 420_000,
    });
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.attempted',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
  });

  it('defers a pending admission until the webhook is durably processed', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      webhookStatus: WebhookStatus.RECEIVED,
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'defer',
      delayMs: 5_000,
      reason: 'source_not_ready',
    });

    expect(harness.prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.admissionStore.suppress).not.toHaveBeenCalled();
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'admission.reconciliation.attempted',
    );
  });

  it.each([
    {
      label: 'webhook database lookup is unknown',
      options: { webhookError: new Error('database unavailable') },
    },
    {
      label: 'exact MAX lookup is unknown',
      options: { exactError: new Error('MAX unavailable') },
    },
    {
      label: 'exact source identity changed',
      options: { exactRows: [exactMessage({ caption: 'Changed before recovery' })] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'suppresses pending recovery when $label',
    async ({ options }) => {
      const harness = buildHarness({ ...options, admissionStates: ['pending'] });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });

      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.admissionStore.suppress).toHaveBeenCalledWith({
        jobId,
        chatId: 'chat-1',
        imageCount: 1,
        tombstoneTtlMs: 600_000,
      });
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
        'admission.reconciliation.attempted',
      );
    },
  );

  it.each(['suppressed', 'expired', 'missing'] as const)(
    'does not analyze when pending reconciliation resolves as %s',
    async (activationResult) => {
      const harness = buildHarness({ admissionStates: ['pending'], activationResult });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });

      expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
      expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
        'admission.reconciliation.suppressed',
      );
    },
  );

  it('absorbs an unknown pending activation and never treats it as actionable', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      activationResult: 'unavailable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.activate.mock.invocationCallOrder[0]).toBeLessThan(
      harness.admissionStore.suppress.mock.invocationCallOrder[0]!,
    );
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.unavailable',
    );
  });

  it('still fails open when both activation and its absorbing tombstone are unavailable', async () => {
    const harness = buildHarness({
      admissionStates: ['pending'],
      activationResult: 'unavailable',
      suppressionResult: 'unavailable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.unavailable',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith('admission.suppression.unavailable');
  });

  it('accepts a producer-won activation race without attempting another state transition', async () => {
    const harness = buildHarness({
      admissionStates: ['pending', 'actionable'],
      activationResult: 'already_actionable',
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
  });

  it.each(['actionable', 'observation'] as const)(
    'does not reconcile an admission initially observed as %s',
    async (state) => {
      const harness = buildHarness({
        mode: state === 'observation' ? 'shadow' : 'on',
        admissionStates: [state],
      });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });

      expect(harness.admissionStore.activate).not.toHaveBeenCalled();
      expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
        'admission.reconciliation.attempted',
      );
    },
  );

  it('suppresses pending recovery when the deadline expires after source validation', async () => {
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + 1_000;
    let nowMs = startedAtMs;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const harness = buildHarness({ admissionStates: ['pending'] });
    harness.maxClient.getExactMessageRow.mockImplementation(async () => {
      nowMs = deadlineAtMs;
      return exactMessage();
    });

    try {
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });
    } finally {
      now.mockRestore();
    }

    expect(harness.admissionStore.activate).not.toHaveBeenCalled();
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.suppressed',
    );
  });

  it('suppresses a recovered admission when the deadline expires during its CAS', async () => {
    const startedAtMs = Date.now();
    const deadlineAtMs = startedAtMs + 1_000;
    let nowMs = startedAtMs;
    const now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const harness = buildHarness({ admissionStates: ['pending'] });
    harness.admissionStore.activate.mockImplementation(async () => {
      nowMs = deadlineAtMs;
      return 'activated';
    });

    try {
      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });
    } finally {
      now.mockRestore();
    }

    expect(harness.admissionStore.activate).toHaveBeenCalledTimes(1);
    expect(harness.admissionStore.suppress).toHaveBeenCalledTimes(1);
    expect(harness.analysisService.analyzeAlbum).not.toHaveBeenCalled();
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.activated',
    );
    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'admission.reconciliation.suppressed',
    );
  });

  it.each([
    { action: 'run' as const, authorized: true },
    { action: 'slow' as const, authorized: false },
    { action: 'pause' as const, authorized: false },
  ])(
    'treats governor $action as heavy-stage authorization=$authorized',
    async ({ action, authorized }) => {
      const harness = buildHarness({
        governorDecision: {
          action,
          retryAfterMs: action === 'run' ? 0 : 20_000,
          reason: 'fixture pressure',
        },
      });

      await expect((harness.service as any).authorizeHeavyStage()).resolves.toBe(authorized);
      expect(harness.governor.decide).toHaveBeenCalledWith({
        component: 'commercial-image-ocr',
        sourceTag: 'commercial_image_ocr',
        ignoredPressureDomains: ['max_api_traffic'],
      });
    },
  );

  it('fails heavy-stage authorization closed when the governor is unavailable', async () => {
    const harness = buildHarness({ governorError: new Error('redis unavailable') });

    await expect((harness.service as any).authorizeHeavyStage()).resolves.toBe(false);
  });

  it.each(['download_failed', 'ocr_failed'] as const)(
    'propagates transient analysis failure %s to the queue processor',
    async (reason) => {
      const harness = buildHarness({ analysis: { kind: 'retry', reason } });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({
        kind: 'retry',
        reason,
      });
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: 'absorbing admission latch is lowered immediately before action',
      options: { latches: [true, true, false] },
    },
    {
      label: 'commercial settings change after analysis',
      options: { finalSettings: settings({ commercialAdsWarnThreshold: 46 }) },
    },
    {
      label: 'exact source changes after analysis',
      options: {
        exactRows: [exactMessage(), exactMessage({ caption: 'Edited after analysis' })],
      },
    },
    {
      label: 'author becomes a remote administrator after analysis',
      options: {
        accessRows: [nonAdminAccess(), { ...nonAdminAccess(), isAdmin: true }],
      },
    },
    {
      label: 'author becomes a local administrator after analysis',
      options: { finalAdminUserIds: ['user-1'] },
    },
  ] satisfies Array<{ label: string; options: HarnessOptions }>)(
    'rechecks final authorization when $label',
    async ({ options }) => {
      const harness = buildHarness(options);

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({
        kind: 'completed',
      });
      expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
      expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'participant immunity is granted', options: { immunityResult: 'granted' as const } },
    {
      label: 'participant immunity lookup fails',
      options: { immunityError: new Error('db down') },
    },
  ])('fails open before action ownership when $label', async ({ options }) => {
    const harness = buildHarness(options);

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });

    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      scope: 'commercial_ocr_delete',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(harness.prisma.moderationViolationMessageClaim.createMany).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it.each([
    ['Latin-only', 'Window repair call +7 999 123 45 67'],
    ['mixed-script', 'Ремонт окон call +7 999 123 45 67'],
    ['phone-only', '+7 999 123 45 67'],
  ])('keeps a %s OCR delete candidate report-only', async (_label, text) => {
    const harness = buildHarness({ analysis: reportOnlyDeleteAnalysis(text) });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.analysisService.analyzeAlbum).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
    expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'before final authorization',
      runtimePolicies: [{ enforce: false }],
      expectedPolicyReads: 1,
      expectsImmunity: false,
    },
    {
      label: 'after final authorization',
      runtimePolicies: [{ enforce: true }, { enforce: false }],
      expectedPolicyReads: 2,
      expectsImmunity: false,
    },
    {
      label: 'immediately before intent commit',
      runtimePolicies: [{ enforce: true }, { enforce: true }, { enforce: false }],
      expectedPolicyReads: 3,
      expectsImmunity: true,
    },
  ])(
    'does not create an intent or call MAX delete when runtime control downgrades $label',
    async ({ runtimePolicies, expectedPolicyReads, expectsImmunity }) => {
      const harness = buildHarness({ runtimePolicies });

      await expect(
        harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
      ).resolves.toEqual({ kind: 'completed' });

      expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(
        expectedPolicyReads,
      );
      expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(
        expectsImmunity ? 1 : 0,
      );
      expect(
        harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
      ).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('reports runtime-control expiry separately from the job deadline', async () => {
    const harness = buildHarness({
      runtimePolicies: [
        { enforce: true },
        { enforce: true },
        { enforce: true, controlExpiresAt: new Date(Date.now() - 1).toISOString() },
      ],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.metrics.recordCounter).toHaveBeenCalledWith(
      'enforcement.suppressed.runtime_control_expired',
    );
    expect(harness.metrics.recordCounter).not.toHaveBeenCalledWith(
      'enforcement.suppressed.deadline',
    );
    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).not.toHaveBeenCalled();
  });

  it('caps initial and final MAX authorization calls by the remaining absolute deadline', async () => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const deadlineAtMs = now + 1_250;
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, deadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(2);
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(2);
    for (const call of harness.maxClient.getExactMessageRow.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeoutMs: 1_250 }));
    }
    for (const call of harness.maxClient.getChatMemberAccess.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeoutMs: 1_250 }));
    }
  });

  it('atomically persists action ownership, intent and binding-only reason metadata', async () => {
    const harness = buildHarness();

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({
      kind: 'completed',
    });

    expect(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim,
    ).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(3);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(settings()),
    });
    expect(harness.participantImmunity.consumeForMessage.mock.invocationCallOrder[0]).toBeLessThan(
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock
        .invocationCallOrder[0]!,
    );
    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.claim).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      userId: 'user-1',
      ruleCode: 'COMMERCIAL_OCR_MESSAGE_ACTION',
      updateType: 'message_action',
    });
    const intent = persisted.intent;
    expect(intent).toMatchObject({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: `commercial-ocr-delete:${jobId}`,
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: 'user-1',
      sourceMessageAt: sourceCreatedAt,
      originBotId: 'execution-bot',
      routingPolicy: 'delete_capable',
      event: { userId: 'user-1', eventType: 'MESSAGE', score: 1 },
    });
    expect(Object.keys(intent.event.metadata)).toEqual(['commercialOcrBinding']);
    const binding = parseCommercialOcrDeleteBinding(intent.event.metadata);
    expect(binding).toMatchObject({
      version: 4,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion: 'tesseract-rus-eng-v1',
      senderId: 'user-1',
      expectedImageCount: 1,
    });
    expect(JSON.stringify(intent.event.metadata)).not.toContain('Buy now');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('photo-1');
    expect(JSON.stringify(intent.event.metadata)).not.toContain('BALANCED');
  });

  it('caps the durable delete deadline at the runtime-control expiry', async () => {
    const controlExpiresAt = new Date(Date.now() + 30_000).toISOString();
    const harness = buildHarness({
      runtimePolicies: [
        { enforce: true, controlExpiresAt },
        { enforce: true, controlExpiresAt },
        { enforce: true, controlExpiresAt },
      ],
    });

    await expect(
      harness.service.processCommercialOcrJob(job(), jobId, activeDeadlineAtMs),
    ).resolves.toEqual({ kind: 'completed' });

    const persisted =
      harness.moderationDeleteIntents.ensureIntentWithMessageActionClaim.mock.calls[0]![0];
    expect(persisted.intent.retryUntilAt).toEqual(new Date(controlExpiresAt));
    expect(persisted.intent.commercialOcrDeadlineAt).toEqual(new Date(controlExpiresAt));
    expect(parseCommercialOcrDeleteBinding(persisted.intent.event.metadata)).toMatchObject({
      controlExpiresAt,
      ocrDeadlineAt: controlExpiresAt,
    });
  });
});

function buildHarness(options: HarnessOptions = {}) {
  const initialSettings = settings();
  const finalSettings = options.finalSettings ?? initialSettings;
  const commitSettings = options.commitSettings ?? finalSettings;
  const normalizedUpdate = options.normalizedUpdate ?? update();
  const exactRows = options.exactRows ?? [exactMessage(), exactMessage()];
  const accessRows = options.accessRows ?? [nonAdminAccess(), nonAdminAccess()];
  const admissionStates =
    options.admissionStates ??
    (options.latches ?? [true, true, true]).map((eligible) =>
      eligible ? ('actionable' as const) : ('observation' as const),
    );
  let exactRowIndex = 0;
  let accessRowIndex = 0;
  let latchIndex = 0;

  const prisma = {
    webhookEvent: {
      findUnique: options.webhookError
        ? jest.fn().mockRejectedValue(options.webhookError)
        : jest.fn().mockResolvedValue({
            botId: 'webhook-bot',
            status: options.webhookStatus ?? WebhookStatus.PROCESSED,
            nextEnqueueAt: null,
            normalizedPayload: normalizedUpdate,
            executionClaims: [{ executionBotId: 'execution-bot' }],
          }),
    },
    chat: {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: initialSettings,
          admins: (options.initialAdminUserIds ?? []).map((userId) => ({ userId })),
        })
        .mockResolvedValueOnce({
          entityType: ChatEntityType.CHAT,
          settings: finalSettings,
          admins: (options.finalAdminUserIds ?? []).map((userId) => ({ userId })),
        })
        .mockResolvedValue({
          entityType: ChatEntityType.CHAT,
          settings: commitSettings,
          admins: (options.finalAdminUserIds ?? []).map((userId) => ({ userId })),
        }),
    },
    moderationViolationMessageClaim: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  };
  const analysisService = {
    analyzeAlbum: jest.fn().mockResolvedValue(options.analysis ?? deleteAnalysis()),
  };
  const admissionStore = {
    resolveState: jest.fn().mockImplementation(async () => {
      const state = readSequence(admissionStates, latchIndex);
      latchIndex += 1;
      return { kind: 'available', state };
    }),
    activate: jest.fn().mockResolvedValue(options.activationResult ?? 'activated'),
    suppress: jest.fn().mockResolvedValue(options.suppressionResult ?? 'suppressed'),
  };
  const governor = {
    decide: options.governorError
      ? jest.fn().mockRejectedValue(options.governorError)
      : jest.fn().mockResolvedValue(
          options.governorDecision ?? {
            action: 'run',
            retryAfterMs: 0,
            reason: 'background headroom available',
          },
        ),
  };
  const maxClient = {
    deleteMessage: jest.fn(),
    getExactMessageRow: jest.fn().mockImplementation(async () => {
      if (options.exactError) {
        throw options.exactError;
      }
      const row = readSequence(exactRows, exactRowIndex);
      exactRowIndex += 1;
      return row;
    }),
    getChatMemberAccess: jest.fn().mockImplementation(async () => {
      const access = readSequence(accessRows, accessRowIndex);
      accessRowIndex += 1;
      return access;
    }),
  };
  const maxBotContextService = {
    runWithBot: jest.fn(async (_botId: string, operation: () => Promise<unknown>) => operation()),
  };
  const maxBotLinkService = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    getDefaultBotId: jest.fn().mockReturnValue('default-bot'),
  };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockImplementation(async () => {
      if (options.immunityError) {
        throw options.immunityError;
      }
      return options.immunityResult ?? 'not_granted';
    }),
  };
  const moderationDeleteIntents = {
    getRolloutForRule: jest.fn().mockReturnValue('execute'),
    ensureIntentWithMessageActionClaim: jest.fn().mockResolvedValue({
      claim: 'claimed',
      intent: { intentId: 'intent-1', rollout: 'execute', status: 'PENDING' },
    }),
  };
  let runtimePolicyIndex = 0;
  const runtimePolicies = options.runtimePolicies ?? [{ enforce: true }];
  const runtimePolicy = {
    resolveEffectivePolicy: jest.fn().mockImplementation(async () => {
      const policy = readSequence(runtimePolicies, runtimePolicyIndex);
      runtimePolicyIndex += 1;
      return {
        mode: policy.enforce ? 'on' : 'shadow',
        process: true,
        enforce: policy.enforce,
        controlRevision: policy.enforce ? 1 : null,
        controlExpiresAt: policy.enforce
          ? (policy.controlExpiresAt ?? new Date(Date.now() + 60_000).toISOString())
          : null,
        enforcementAuthority: policy.enforce ? 'authorized' : 'revoked',
      };
    }),
  };
  const configService = new ConfigService({
    COMMERCIAL_OCR_ROLLOUT_MODE: options.mode ?? 'on',
    COMMERCIAL_OCR_RESERVATION_TTL_MS: options.reservationTtlMs,
  });
  const metrics = { recordCounter: jest.fn() };
  const service = new CommercialOcrModerationService(
    prisma as never,
    analysisService as never,
    admissionStore as never,
    governor as never,
    maxClient as never,
    maxBotContextService as never,
    maxBotLinkService as never,
    participantImmunity as never,
    moderationDeleteIntents as never,
    runtimePolicy as never,
    configService,
    metrics as never,
  );

  return {
    service,
    prisma,
    analysisService,
    admissionStore,
    governor,
    maxClient,
    participantImmunity,
    moderationDeleteIntents,
    runtimePolicy,
    metrics,
  };
}

function job(overrides: Partial<CommercialOcrJob> = {}): CommercialOcrJob {
  return {
    webhookEventId: 'webhook-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    sourceCreatedAt,
    imageCount: 1,
    schemaVersion: COMMERCIAL_OCR_JOB_SCHEMA_VERSION,
    ocrVersion: 'tesseract-rus-eng-v1',
    actionEligible: true,
    idempotencyKey: jobId,
    sourceTag: 'commercial-image-ocr',
    createdAt: sourceCreatedAt,
    ...overrides,
  };
}

function settings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED',
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    ...overrides,
  } as ChatSettings;
}

function update(
  options: { messageId?: string; incompleteAttachment?: boolean; downloadUrl?: string } = {},
): MaxUpdate {
  const messageId = options.messageId ?? 'message-1';
  const attachment = options.incompleteAttachment
    ? { type: 'image', payload: {} }
    : photoAttachment('photo-1', options.downloadUrl);
  return {
    updateId: 'update-1',
    botId: 'payload-bot',
    type: 'message_created',
    message: {
      messageId,
      chatId: 'chat-1',
      senderId: 'user-1',
      senderName: 'User One',
      text: 'Buy now',
      createdAt: sourceCreatedAt,
    },
    raw: {
      message: {
        id: messageId,
        timestamp: sourceCreatedAt,
        recipient: { chat_id: 'chat-1' },
        sender: { user_id: 'user-1', is_bot: false },
        body: { mid: messageId, text: 'Buy now', attachments: [attachment] },
      },
    },
  };
}

function exactMessage(
  options: {
    photoId?: string | null;
    caption?: string;
    downloadUrl?: string | null;
    sender?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const photoId = options.photoId === undefined ? 'photo-1' : options.photoId;
  const downloadUrl =
    options.downloadUrl === undefined ? 'https://i.oneme.ru/photo-1' : options.downloadUrl;
  return {
    id: 'message-1',
    timestamp: sourceCreatedAt,
    recipient: { chat_id: 'chat-1' },
    sender: options.sender ?? { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: options.caption ?? 'Buy now',
      attachments: [
        {
          type: 'image',
          payload: {
            ...(photoId === null ? {} : { photo_id: photoId }),
            ...(downloadUrl === null ? {} : { url: downloadUrl }),
          },
        },
      ],
    },
  };
}

function photoAttachment(photoId: string, downloadUrl = `https://i.oneme.ru/${photoId}`) {
  return {
    type: 'image',
    payload: {
      photo_id: photoId,
      url: downloadUrl,
    },
  };
}

function nonAdminAccess(): AccessFixture {
  return {
    userId: 'user-1',
    isAdmin: false,
    isOwner: false,
    permissions: [],
  };
}

function deleteAnalysis(
  text = 'Ремонт окон, звоните +7 999 123 45 67',
): Extract<AnalysisFixture, { kind: 'complete' }> {
  return {
    kind: 'complete',
    decision: evaluateCommercialOcrDecision({
      caption: '',
      expectedImageCount: 1,
      images: [
        {
          imageIndex: 0,
          source: 'direct',
          primary: recognizedPass(text),
          verification: recognizedPass(text),
        },
      ],
      settings: settings(),
      detector: {
        detect: () => deleteDetection(text),
      },
    }),
  };
}

function reportOnlyDeleteAnalysis(text: string): Extract<AnalysisFixture, { kind: 'complete' }> {
  const base = deleteAnalysis();
  const letterScript = /\p{Script=Latin}/u.test(text)
    ? /\p{Script=Cyrillic}/u.test(text)
      ? 'mixed'
      : 'latin_only'
    : /\p{Script=Cyrillic}/u.test(text)
      ? 'cyrillic_only'
      : 'unknown';
  return {
    kind: 'complete',
    decision: {
      ...base.decision,
      images: base.decision.images.map((image) => ({
        ...image,
        primary: { ...image.primary, letterScript },
        verification: image.verification
          ? { ...image.verification, letterScript }
          : image.verification,
      })),
    },
  };
}

function noActionDecision(reasonCodes: string[]): CommercialOcrDecision {
  return {
    ...deleteAnalysis().decision,
    action: 'NO_ACTION',
    deleteSource: null,
    reasonCodes,
  };
}

function recognizedPass(text: string): CommercialOcrPass {
  return {
    status: 'recognized',
    text,
    confidencePermille: 950,
    criticalEvidence: [
      { kind: 'commercial_anchor', semanticKey: 'service:repair', confidencePermille: 950 },
      { kind: 'contact', semanticKey: 'phone:+79991234567', confidencePermille: 950 },
    ],
  };
}

function deleteDetection(rawText: string) {
  return {
    rawText,
    confidenceScore: 99,
    decisionBand: 'HIGH' as const,
    matchedSignals: ['service-specialty:repair', 'contact:phone'],
    negativeSignals: [],
    primarySubtype: 'SERVICES' as const,
    supportingSubtypes: [],
    evidenceStrength: 'DIRECT' as const,
    reviewRecommended: false,
    reviewReasons: [],
    campaignContext: null,
    appliedThresholds: {
      warnThreshold: 45,
      deleteThreshold: 65,
      sensitivity: 'BALANCED' as const,
      strictness: 0.5,
    },
    classifierVersion: 'test',
    commercialProbability: 0.99,
    reviewProbability: 0,
    classifierReasons: [],
    actionScore: 99,
    policyFpRisk: 0,
    evidenceTier: 'DIRECT',
    actionBand: 'DELETE',
    safeContextBucket: 'none',
    actionable: true,
    recordable: true,
    deleteSuppressed: false,
    suppressionReasons: [],
    reasonCodes: [],
  };
}

function readSequence<T>(values: readonly T[], index: number): T {
  const value = values[Math.min(index, values.length - 1)];
  if (value === undefined) {
    throw new Error('Fixture sequence is empty');
  }
  return value;
}
