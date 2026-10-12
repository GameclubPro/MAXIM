import type { DuplicateFingerprint } from '../rule-engine-duplicate-detector';
import { selectMessageDuplicateFingerprints } from './message-duplicate-history.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { extractDuplicateMessageContent } from './message-duplicate-content';
import { duplicateSettings } from './message-duplicate-test-fixtures';

describe('duplicate history reply budget', () => {
  afterEach(() => jest.useRealTimers());

  function fixture() {
    let reply!: (value: { kind: string; revision: string; matches: never[] }) => void;
    const pending = new Promise<{ kind: string; revision: string; matches: never[] }>((resolve) => {
      reply = resolve;
    });
    const redis = { duplicateWindow: jest.fn(() => pending) };
    const metrics = { record: jest.fn() };
    const history = new MessageDuplicateHistoryService(redis as never, metrics as never);
    const input = {
      chatId: '-123',
      userId: '123',
      messageId: 'first',
      eventTimestampMs: Date.now(),
      controlRevision: 1,
      settings: duplicateSettings(),
      content: extractDuplicateMessageContent({ message: { body: { text: 'one original' } } }),
    };
    return {
      redis,
      metrics,
      history,
      input,
      reply: () => reply({ kind: 'ok', revision: 'a'.repeat(64), matches: [] }),
    };
  }

  it('awaits a timely Redis mutation whose reply arrives after 250 ms without issuing it twice', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const result = f.history.observeWithOutcome(f.input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(450);
    f.reply();
    expect(await result).toEqual({ value: { outcome: 'COMPARED_NO_MATCH', match: null } });
    expect(f.redis.duplicateWindow).toHaveBeenCalledTimes(1);
    expect(f.metrics.record).not.toHaveBeenCalledWith('history.unavailable');
  });

  it('retains the failure and never retries or converts a reply after one second into a match', async () => {
    jest.useFakeTimers();
    const f = fixture();
    const result = f.history.observeWithOutcome(f.input).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await jest.advanceTimersByTimeAsync(1001);
    expect(await result).toEqual({
      error: new Error('Message duplicate history deadline exceeded'),
    });
    f.reply();
    await jest.advanceTimersByTimeAsync(1);
    expect(f.redis.duplicateWindow).toHaveBeenCalledTimes(1);
    expect(f.metrics.record).toHaveBeenCalledWith('history.unavailable');
    expect(f.metrics.record).not.toHaveBeenCalledWith('history.no_match_or_allowed');
  });
});

describe('bounded message duplicate fingerprints', () => {
  const many = (type: DuplicateFingerprint['type'], count: number): DuplicateFingerprint[] =>
    Array.from({ length: count }, (_, index) => ({ type, value: `${type}-${index}` }));

  it('preserves the original selection below the budget', () => {
    const input = [...many('exact', 1), ...many('link', 8), ...many('phone', 2)];
    expect(selectMessageDuplicateFingerprints(input)).toEqual(input);
  });

  it('reserves room for each enabled kind without increasing the budget', () => {
    const selected = selectMessageDuplicateFingerprints([
      ...many('exact', 1),
      ...many('link', 40),
      ...many('phone', 40),
      ...many('content', 1),
      ...many('near', 1),
    ]);
    expect(selected).toHaveLength(16);
    expect(selected[0]?.type).toBe('exact');
    expect(new Set(selected.map((part) => part.type))).toEqual(
      new Set(['exact', 'link', 'phone', 'content', 'near']),
    );
    expect(new Set(selected.map((part) => part.value)).size).toBe(16);
  });

  it('selects the same bounded values when links and phones are reordered', () => {
    const exact = many('exact', 1);
    const links = many('link', 40);
    const phones = many('phone', 40);
    expect(selectMessageDuplicateFingerprints([...exact, ...links, ...phones])).toEqual(
      selectMessageDuplicateFingerprints([...exact, ...links.reverse(), ...phones.reverse()]),
    );
  });
});
