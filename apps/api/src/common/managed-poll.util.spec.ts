import {
  buildManagedPollButtons,
  buildManagedPollMessageText,
  buildManagedPollOptionResults,
  parseManagedPollCallbackPayload,
} from './managed-poll.util';
import { measureMaxInlineKeyboardTextWeight } from '../max/max-inline-keyboard-layout';

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
      'Да  ███████░░░ 70% · 7',
      'Нет  ███░░░░░░░ 30% · 3',
    ]);
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
      'Первый  ███████░░░ 67% · 2',
      'Второй  ███░░░░░░░ 33% · 1',
    ]);
  });

  it('compacts long option text without hiding results', () => {
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

    expect(longButton?.[0]?.text).toBe('Очень длинный вар…  ██████████ 100% · 1');
    expect(longButton?.[0]).toMatchObject({ payload: 'poll|v2|poll-1|option-a' });
    expect(measureMaxInlineKeyboardTextWeight(longButton?.[0]?.text ?? '')).toBeLessThanOrEqual(36);
  });

  it('measures compound emoji by code point while truncating only at grapheme boundaries', () => {
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

    expect(label).toBe('👨‍👩‍👧‍👦…  ░░░░░░░░░░ 0% · 0');
    expect(label).not.toMatch(/\u200d…/u);
    expect(measureMaxInlineKeyboardTextWeight(label)).toBeLessThanOrEqual(36);
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

    expect(button?.[0]?.text).toBe('Да точно  ░░░░░░░░░░ 0% · 0');
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
