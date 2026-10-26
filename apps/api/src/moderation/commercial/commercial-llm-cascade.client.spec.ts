import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmError } from './commercial-llm.client';
import { commercialLlmMayDelete } from './commercial-llm-enforcement.protocol';
import {
  COMMERCIAL_LLM_MODEL_SHA256,
  COMMERCIAL_LLM_PROMPT_SHA256,
  COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
  COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
  COMMERCIAL_LLM_POLICY_VERSION,
} from './commercial-llm.protocol';
import type {
  CommercialLlmClassifier,
  CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import type { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { COMMERCIAL_LLM_WORKSTATION_IDENTITY } from './commercial-llm-workstation.protocol';

const primaryResult: CommercialLlmObservationResult = {
  ...COMMERCIAL_LLM_WORKSTATION_IDENTITY,
  policyVersion: 'synthetic',
  classification: 'NOT_COMMERCIAL',
  reasonCodes: ['PERSONAL_SALE'],
  durationMs: 30,
};
describe('bounded commercial model cascade', () => {
  const primary = {
    classify: jest.fn<
      ReturnType<CommercialLlmWorkstationMailbox['classify']>,
      Parameters<CommercialLlmWorkstationMailbox['classify']>
    >(),
  };
  const secondary = {
    classify: jest.fn<
      ReturnType<CommercialLlmClassifier['classify']>,
      Parameters<CommercialLlmClassifier['classify']>
    >(),
  };
  const auditSecondary = {
    classify: jest.fn<
      ReturnType<CommercialLlmClassifier['classify']>,
      Parameters<CommercialLlmClassifier['classify']>
    >(),
  };
  const primaryFinished = jest.fn<Promise<void>, []>();
  const pressure = jest.fn(async () => true);
  const lease = jest.fn(async () => true);
  beforeEach(() => {
    primary.classify.mockReset().mockResolvedValue({ outcome: 'COMPLETE', result: primaryResult });
    secondary.classify.mockReset().mockResolvedValue({
      ...primaryResult,
      modelAlias: 'secondary',
      modelSha256: 'secondary-sha',
    });
    auditSecondary.classify.mockReset().mockResolvedValue({
      ...primaryResult,
      modelAlias: 'audit-secondary',
    });
    primaryFinished.mockReset().mockResolvedValue(undefined);
    pressure.mockReset().mockResolvedValue(true);
    lease.mockReset().mockResolvedValue(true);
  });
  const client = (audit = false) =>
    new CommercialLlmCascadeClient(
      primary,
      secondary,
      pressure,
      () => audit,
      primaryFinished,
      auditSecondary,
    );
  it('keeps actual primary attribution without invoking secondary for an unaudited negative', async () => {
    const result = await client().classify('synthetic', undefined, lease);
    expect(result.modelAlias).toBe(COMMERCIAL_LLM_WORKSTATION_IDENTITY.modelAlias);
    expect(result.cascade?.route).toBe('primary');
    expect(secondary.classify).not.toHaveBeenCalled();
  });
  it.each(['COMMERCIAL', 'UNSURE'] as const)(
    'requires secondary for %s',
    async (classification) => {
      primary.classify.mockResolvedValue({
        outcome: 'COMPLETE',
        result: { ...primaryResult, classification },
      });
      const result = await client().classify('synthetic', undefined, lease);
      expect(result.modelAlias).toBe('secondary');
      expect(secondary.classify).toHaveBeenCalledTimes(1);
      expect(result.cascade?.primaryClassification).toBe(classification);
    },
  );
  it.each(['UNAVAILABLE', 'BUSY', 'TIMEOUT', 'FAILED'] as const)(
    'falls back once for %s',
    async (outcome) => {
      primary.classify.mockResolvedValue({ outcome });
      expect((await client().classify('synthetic', undefined, lease)).cascade?.route).toBe(
        `secondary_${outcome.toLowerCase()}`,
      );
      expect(secondary.classify).toHaveBeenCalledTimes(1);
    },
  );
  it('audits negatives using secondary attribution', async () => {
    const result = await client(true).classify('synthetic', undefined, lease);
    expect(result.cascade?.route).toBe('secondary_audit');
    expect(result.modelAlias).toBe('audit-secondary');
    expect(auditSecondary.classify).toHaveBeenCalledTimes(1);
    expect(secondary.classify).not.toHaveBeenCalled();
  });
  it.each(['success', 'failure'] as const)(
    'waits for primary resource release before completion or server fallback after primary %s',
    async (outcome) => {
      if (outcome === 'failure') primary.classify.mockRejectedValue(new Error('offline'));
      let release!: () => void;
      primaryFinished.mockReturnValue(
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      );
      let settled = false;
      const classification = client().classify('synthetic', undefined, lease);
      void classification.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(primaryFinished).toHaveBeenCalledTimes(1);
        expect(settled).toBe(false);
        expect(secondary.classify).not.toHaveBeenCalled();
        expect(auditSecondary.classify).not.toHaveBeenCalled();
      } finally {
        release();
      }
      const result = await classification;
      expect(result.cascade?.route).toBe(outcome === 'success' ? 'primary' : 'secondary_failed');
      expect(primaryFinished).toHaveBeenCalledTimes(1);
      expect(secondary.classify).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
    },
  );
  it('does not request server confirmation after primary resource release is rejected', async () => {
    primary.classify.mockResolvedValue({
      outcome: 'COMPLETE',
      result: { ...primaryResult, classification: 'COMMERCIAL', reasonCodes: ['COMMERCIAL_OFFER'] },
    });
    primaryFinished.mockRejectedValue(new Error('primary ownership lost'));
    await expect(client().classify('synthetic', undefined, lease)).rejects.toThrow(
      'primary ownership lost',
    );
    expect(primaryFinished).toHaveBeenCalledTimes(1);
    expect(pressure).not.toHaveBeenCalled();
    expect(secondary.classify).not.toHaveBeenCalled();
    expect(auditSecondary.classify).not.toHaveBeenCalled();
  });
  it('uses the separate fail-fast negative audit without falling through to queued confirmation', async () => {
    auditSecondary.classify.mockRejectedValue(new CommercialLlmError('BUSY'));
    await expect(client(true).classify('synthetic', undefined, lease)).rejects.toMatchObject({
      kind: 'BUSY',
    });
    expect(auditSecondary.classify).toHaveBeenCalledTimes(1);
    expect(secondary.classify).not.toHaveBeenCalled();
    expect(primaryFinished).toHaveBeenCalledTimes(1);
  });
  it('retains the primary-negative veto when a server audit disagrees', async () => {
    auditSecondary.classify.mockResolvedValue({
      ...primaryResult,
      classification: 'COMMERCIAL',
      reasonCodes: ['COMMERCIAL_OFFER'],
      modelSha256: COMMERCIAL_LLM_MODEL_SHA256,
      promptSha256: COMMERCIAL_LLM_PROMPT_SHA256,
      runtimeImageSha256: COMMERCIAL_LLM_RUNTIME_IMAGE_SHA256,
      chatTemplateSha256: COMMERCIAL_LLM_CHAT_TEMPLATE_SHA256,
      policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
    });
    const result = await client(true).classify('synthetic', undefined, lease);
    expect(result).toMatchObject({
      classification: 'COMMERCIAL',
      cascade: { route: 'secondary_audit', primaryClassification: 'NOT_COMMERCIAL' },
    });
    expect(commercialLlmMayDelete(result)).toBe(false);
    expect(
      commercialLlmMayDelete({
        ...result,
        cascade: { ...result.cascade!, primaryClassification: 'UNSURE' },
      }),
    ).toBe(true);
    expect(secondary.classify).not.toHaveBeenCalled();
  });
  it.each(['pressure', 'lease', 'abort'])(
    'sheds rather than trusting a positive after %s changes',
    async (guard) => {
      primary.classify.mockResolvedValue({
        outcome: 'COMPLETE',
        result: { ...primaryResult, classification: 'COMMERCIAL' },
      });
      const controller = new AbortController();
      if (guard === 'pressure') pressure.mockResolvedValue(false);
      if (guard === 'lease') lease.mockResolvedValue(false);
      if (guard === 'abort')
        primary.classify.mockImplementation(async () => {
          controller.abort();
          return { outcome: 'FAILED' };
        });
      await expect(client().classify('synthetic', controller.signal, lease)).rejects.toBeInstanceOf(
        CommercialLlmError,
      );
      expect(secondary.classify).not.toHaveBeenCalled();
    },
  );
  it('does not convert both-model failure to a negative', async () => {
    primary.classify.mockRejectedValue(new Error('offline'));
    secondary.classify.mockRejectedValue(new Error('offline'));
    await expect(client().classify('synthetic', undefined, lease)).rejects.toThrow('offline');
  });
});
