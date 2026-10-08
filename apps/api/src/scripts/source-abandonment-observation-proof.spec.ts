import { isUnrelatedSourceAbandonmentFanoutObservation } from './source-abandonment-live-redis';

const sources = [
  { chatId: '-100', messageId: 'selected-message', userId: '100' },
  { chatId: '-200', messageId: 'second-message', userId: '200' },
];
const data = {
  observationId: 'observation-1',
  userId: '300',
  chatId: '-300',
  source: 'FANOUT_HIGH',
  fastPath: false,
  createdAt: '2026-08-07T08:38:14.698Z',
  observedAt: '2026-08-07T08:38:12.001Z',
};
const observation = {
  id: data.observationId,
  userId: data.userId,
  chatId: data.chatId,
  messageId: null,
  source: data.source,
  observedAt: new Date('2026-09-08T11:40:23.045Z'),
};

describe('non-message fanout observation inventory proof', () => {
  it('proves independence from exact current identities despite a legitimate observedAt upsert', () => {
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, sources)).toBe(true);
  });

  it('refuses an absent row or empty selection', () => {
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, null, sources)).toBe(false);
    expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, [])).toBe(false);
  });

  it.each([
    { id: 'different-observation' },
    { id: undefined },
    { userId: 'different-user' },
    { userId: null },
    { chatId: 'different-chat' },
    { chatId: undefined },
    { source: 'FANOUT_REPEAT' },
    { source: undefined },
    { messageId: undefined },
    { messageId: '' },
    { messageId: 'some-message' },
  ])('refuses an incomplete or mismatched persisted observation: %j', (change) => {
    expect(
      isUnrelatedSourceAbandonmentFanoutObservation(data, { ...observation, ...change }, sources),
    ).toBe(false);
  });

  it.each([
    { observationId: undefined },
    { observationId: ' observation-1' },
    { userId: '' },
    { chatId: '' },
    { source: 'UNKNOWN' },
    { source: 'FANOUT_REPEAT' },
    { fastPath: true },
    { fastPath: undefined },
    { fastPath: 'false' },
  ])('refuses a malformed or unsupported job: %j', (change) => {
    expect(
      isUnrelatedSourceAbandonmentFanoutObservation({ ...data, ...change }, observation, sources),
    ).toBe(false);
  });

  it.each(sources)(
    'refuses an overlapping user or chat anywhere in the selection: %j',
    (source) => {
      for (const change of [{ userId: source.userId }, { chatId: source.chatId }]) {
        expect(
          isUnrelatedSourceAbandonmentFanoutObservation(
            { ...data, ...change },
            { ...observation, ...change },
            sources,
          ),
        ).toBe(false);
      }
    },
  );
  it.each([
    { chatId: '-0100' },
    { chatId: '-0300' },
    { chatId: '+300' },
    { chatId: '0' },
    { userId: '0100' },
    { userId: '0300' },
    { userId: '+300' },
    { userId: '0' },
    { userId: 'not-numeric' },
  ])('refuses aliases and unsupported numeric identities: %j', (change) => {
    expect(
      isUnrelatedSourceAbandonmentFanoutObservation(
        { ...data, ...change },
        { ...observation, ...change },
        sources,
      ),
    ).toBe(false);
  });

  it.each([{ chatId: '-0300' }, { userId: '0300' }, { userId: null }])(
    'refuses a selection alias or unknown subject: %j',
    (change) => {
      const malformed = [{ ...sources[0], ...change }] as unknown as typeof sources;
      expect(isUnrelatedSourceAbandonmentFanoutObservation(data, observation, malformed)).toBe(
        false,
      );
    },
  );
});
