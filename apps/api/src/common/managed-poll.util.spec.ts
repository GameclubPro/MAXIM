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

  it('keeps callback labels exactly as the administrator entered them', () => {
    const buttons = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(options, new Map([['option-a', 12]])).options,
    );

    expect(buttons.map((row) => row[0]?.text)).toEqual(['Первый', 'Второй']);
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

  it('publishes only the administrator-authored question in every poll state', () => {
    const result = buildManagedPollOptionResults(options, new Map([['option-a', 1]]));
    const active = buildManagedPollMessageText({
      question: 'Что выбираем?',
    });
    const closed = buildManagedPollMessageText({
      question: 'Что выбираем?',
    });

    expect(result.totalVotes).toBe(1);
    expect(active).toBe('Что выбираем?');
    expect(closed).toBe('Что выбираем?');
    expect(`${active}\n${closed}`).not.toMatch(/Опрос|завершён|голос|Первый|Анонимный|Открытый/u);
  });

  it('renders only administrator-authored Markdown without adding result text', () => {
    const text = buildManagedPollMessageText({
      question: '**Выберите вариант**',
      questionFormat: 'markdown',
    });

    expect(text).toBe('<strong>Выберите вариант</strong>');
  });
});
