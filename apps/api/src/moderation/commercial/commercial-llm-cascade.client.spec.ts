import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmError } from './commercial-llm.client';
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
  const pressure = jest.fn(async () => true);
  const lease = jest.fn(async () => true);
  beforeEach(() => {
    primary.classify.mockReset().mockResolvedValue({ outcome: 'COMPLETE', result: primaryResult });
    secondary.classify
      .mockReset()
      .mockResolvedValue({
        ...primaryResult,
        modelAlias: 'secondary',
        modelSha256: 'secondary-sha',
      });
    pressure.mockReset().mockResolvedValue(true);
    lease.mockReset().mockResolvedValue(true);
  });
  const client = (audit = false) =>
    new CommercialLlmCascadeClient(primary, secondary, pressure, () => audit);
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
    expect((await client(true).classify('synthetic', undefined, lease)).cascade?.route).toBe(
      'secondary_audit',
    );
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
