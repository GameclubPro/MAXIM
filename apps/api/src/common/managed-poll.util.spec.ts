import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionResults,
  parseManagedPollCallbackPayload,
} from './managed-poll.util';

describe('managed poll util', () => {
  const options = [
    { id: 'option-a', position: 0, text: 'Первый' },
    { id: 'option-b', position: 1, text: 'Второй' },
  ];

  it('builds stable callback payloads from poll and option ids', () => {
    const [firstRow] = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(options, new Map([['option-a', 2]])).options,
    );
    const payload = firstRow?.[0]?.type === 'callback' ? firstRow[0].payload : null;

    expect(payload).toBe('poll|v2|poll-1|option-a');
    expect(parseManagedPollCallbackPayload(payload)).toEqual({
      pollId: 'poll-1',
      optionId: 'option-a',
    });
    expect(parseManagedPollCallbackPayload('poll|v1|poll-1|option-a')).toBeNull();
  });

  it('calculates aggregate counts and rounded percentages', () => {
    const result = buildManagedPollOptionResults(
      options,
      new Map([
        ['option-a', 2],
        ['option-b', 1],
      ]),
    );

    expect(result.totalVotes).toBe(3);
    expect(result.options.map((option) => option.percent)).toEqual([67, 33]);
  });

  it('keeps rounded percentages at exactly one hundred', () => {
    const result = buildManagedPollOptionResults(
      [...options, { id: 'option-c', position: 2, text: 'Третий' }],
      new Map([
        ['option-a', 1],
        ['option-b', 1],
        ['option-c', 1],
      ]),
    );

    expect(result.options.map((option) => option.percent)).toEqual([34, 33, 33]);
    expect(result.options.reduce((sum, option) => sum + option.percent, 0)).toBe(100);
  });

  it('keeps active posts concise and renders final results after close', () => {
    const result = buildManagedPollOptionResults(options, new Map([['option-a', 1]]));
    const active = buildManagedPollMessageText({
      question: 'Что выбираем?',
      options: result.options,
      status: 'ACTIVE',
      visibility: 'ANONYMOUS',
      totalVotes: result.totalVotes,
    });
    const closed = buildManagedPollMessageText({
      question: 'Что выбираем?',
      options: result.options,
      status: 'CLOSED',
      visibility: 'OPEN',
      totalVotes: result.totalVotes,
    });

    expect(active).toBe('Опрос\n\nЧто выбираем?\n\n1 голос · Анонимный');
    expect(active).not.toContain('1. Первый');
    expect(closed).toContain('Опрос завершён');
    expect(closed).toContain('1. Первый — 1 · 100%');
    expect(closed).toContain('1 голос · Открытый');
  });
});
