import { buildManagedPollMessageText } from './managed-poll.util';

describe('managed poll message text', () => {
  const optionResults = [
    { option: 'Соло', votes: 2, percent: 67 },
    { option: 'Сквад', votes: 1, percent: 33 },
  ] as const;

  it('keeps active poll post text focused on the question when buttons already contain options', () => {
    const text = buildManagedPollMessageText('Какой режим выбираем?', optionResults, 'ACTIVE');

    expect(text).toBe('Опрос\n\nКакой режим выбираем?');
    expect(text).not.toContain('1. Соло');
    expect(text).not.toContain('2. Сквад');
  });

  it('includes detailed option results after the poll is closed', () => {
    const text = buildManagedPollMessageText('Какой режим выбираем?', optionResults, 'CLOSED');

    expect(text).toContain('Опрос');
    expect(text).toContain('Какой режим выбираем?');
    expect(text).toContain('1. Соло - 2 (67%)');
    expect(text).toContain('2. Сквад - 1 (33%)');
  });
});
