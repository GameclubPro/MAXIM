import {
  buildManagedPollButtons,
  buildManagedPollCallbackPayloadPrefix,
  buildManagedPollCallbackPayloadPrefixes,
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
      publicationToken: null,
    });
    expect(parseManagedPollCallbackPayload('poll|v1|poll-1|option-a')).toBeNull();
    expect(buildManagedPollCallbackPayloadPrefix('poll-1')).toBe('poll|v2|poll-1|');
  });

  it('binds current callback payloads to one publication attempt', () => {
    const [firstRow] = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(options, new Map()).options,
      'claim-token-1',
    );
    const payload = firstRow?.[0]?.type === 'callback' ? firstRow[0].payload : null;

    expect(payload).toBe('poll|v3|poll-1|claim-token-1|option-a');
    expect(parseManagedPollCallbackPayload(payload)).toEqual({
      pollId: 'poll-1',
      optionId: 'option-a',
      publicationToken: 'claim-token-1',
    });
    expect(parseManagedPollCallbackPayload('poll|v3|poll-1||option-a')).toBeNull();
    expect(buildManagedPollCallbackPayloadPrefixes('poll-1')).toEqual([
      'poll|v2|poll-1|',
      'poll|v3|poll-1|',
    ]);
  });

  it('adds a ten-cell result bar, percentage, and vote count to callback labels', () => {
    const buttons = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(
        [
          { id: 'option-a', position: 0, text: 'Да' },
          { id: 'option-b', position: 1, text: 'Нет' },
        ],
        new Map([
          ['option-a', 7],
          ['option-b', 3],
        ]),
      ).options,
    );

    expect(buttons.map((row) => row[0]?.text)).toEqual([
      'Да  ███████░░░ 70%(7)',
      'Нет  ███░░░░░░░ 30%(3)',
    ]);
  });

  it('renders the requested compact percentage and count format', () => {
    const buttons = buildManagedPollButtons('poll-1', [
      { id: 'option-a', position: 0, text: '1', votes: 1, percent: 50 },
    ]);

    expect(buttons[0]?.[0]?.text).toBe('1  █████░░░░░ 50%(1)');
  });

  it('rounds progress cells while keeping the exact percentages and counts', () => {
    const buttons = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(
        options,
        new Map([
          ['option-a', 2],
          ['option-b', 1],
        ]),
      ).options,
    );

    expect(buttons.map((row) => row[0]?.text)).toEqual([
      'Первый  ███████░░░ 67%(2)',
      'Второй  ███░░░░░░░ 33%(1)',
    ]);
  });

  it('drops the progress bar at the visual boundary without truncating the option', () => {
    const buttons = buildManagedPollButtons('poll-1', [
      { id: 'option-a', position: 0, text: 'Д'.repeat(19), votes: 1, percent: 50 },
      { id: 'option-b', position: 1, text: 'Д'.repeat(20), votes: 1, percent: 50 },
    ]);

    expect(buttons[0]?.[0]?.text).toBe(`${'Д'.repeat(19)}  █████░░░░░ 50%(1)`);
    expect(buttons[1]?.[0]?.text).toBe(`${'Д'.repeat(20)}  50%(1)`);
  });

  it('keeps exceptionally long option text intact after dropping the progress bar', () => {
    const [longButton] = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(
        [
          {
            id: 'option-a',
            position: 0,
            text: 'Очень длинный вариант ответа для мобильного клиента',
          },
        ],
        new Map([['option-a', 1]]),
      ).options,
    );

    expect(longButton?.[0]?.text).toBe(
      'Очень длинный вариант ответа для мобильного клиента  100%(1)',
    );
    expect(longButton?.[0]?.text).not.toMatch(/[█░…]/u);
    expect(longButton?.[0]).toMatchObject({ payload: 'poll|v2|poll-1|option-a' });
  });

  it('keeps compound emoji intact after dropping the progress bar', () => {
    const [button] = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(
        [
          {
            id: 'option-a',
            position: 0,
            text: '👨‍👩‍👧‍👦👨‍👩‍👧‍👦 Семейный вариант',
          },
        ],
        new Map(),
      ).options,
    );
    const label = button?.[0]?.text ?? '';

    expect(label).toBe('👨‍👩‍👧‍👦👨‍👩‍👧‍👦 Семейный вариант  0%(0)');
  });

  it('keeps an eighty-character option intact without a progress bar', () => {
    const optionText = 'Д'.repeat(80);
    const [button] = buildManagedPollButtons('poll-1', [
      { id: 'option-a', position: 0, text: optionText, votes: 12, percent: 100 },
    ]);

    expect(button?.[0]?.text).toBe(`${optionText}  100%(12)`);
  });

  it('keeps result labels on one line when authored options contain whitespace runs', () => {
    const [button] = buildManagedPollButtons(
      'poll-1',
      buildManagedPollOptionResults(
        [
          { id: 'option-a', position: 0, text: 'Да\n\tточно' },
          { id: 'option-b', position: 1, text: 'Нет' },
        ],
        new Map(),
      ).options,
    );

    expect(button?.[0]?.text).toBe('Да точно  ░░░░░░░░░░ 0%(0)');
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

  it('keeps the message body limited to the administrator-authored question', () => {
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

  it('keeps generated results out of an administrator-authored Markdown question', () => {
    const text = buildManagedPollMessageText({
      question: '**Выберите вариант**',
      questionFormat: 'markdown',
    });

    expect(text).toBe('<strong>Выберите вариант</strong>');
  });
});
