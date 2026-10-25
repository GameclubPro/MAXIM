import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eligibleQuestion,
  knowledge,
  selectKnowledge,
  validateSupportAnswer,
} from './support-llm-client.mjs';

const roleClarification = [
  { role: 'user', text: 'Как выложить объявление?' },
  { role: 'assistant', text: 'Вы участник группы или её администратор?' },
];

function checkCases(cases, check) {
  const failures = [];
  for (const value of cases) {
    try {
      check(value);
    } catch (error) {
      failures.push(error.message);
    }
  }
  assert.equal(failures.length, 0, failures.join('\n\n'));
}

test('direct support complaints reach the model without a question mark or the word bot', () => {
  checkCases(
    [
      'Объявление заблокировали',
      'Обьявления не размещаются',
      'Моё обявление опять снесли',
      'Меня заблокировали в группе',
      'Дублирует сообщения',
      'Настройки слетели',
      'Нужна помощь с настройками',
      'Не работают стопслова',
      'Не приходят уведомления',
      'Не могу включить подписку',
      'Рэкс сносит частные объявления',
      'Подключил но нет чата',
      'Хочу запостить в канале',
    ],
    (text) => assert.equal(eligibleQuestion(text), true, text),
  );
});

test('advertisement spelling variants preserve the placement and removal instructions', () => {
  checkCases(
    [
      ['Как разместить обьявление?', 'announcement-placement'],
      ['Как выложить обявление?', 'announcement-placement'],
      ['Как выложить объяву?', 'announcement-placement'],
      ['Почему снесли обьявление?', 'announcement-removal'],
      ['Моё обявление опять снесли', 'announcement-removal'],
      ['Рэкс сносит частные объявления', 'announcement-removal'],
    ],
    ([text, expected]) => {
      assert.equal(eligibleQuestion(text), true, text);
      const ids = selectKnowledge(text)
        .slice(0, 4)
        .map((entry) => entry.id);
      assert.ok(ids.includes(expected), `${text}: ${ids.join(', ')}`);
    },
  );
});

test('compound and separated feature names select the procedure before generic bot information', () => {
  checkCases(
    [
      ['Как настроить стопслова?', 'stop-words'],
      ['Не работают стопслова', 'stop-words'],
      ['Как настроить стоп-слова?', 'stop-words'],
      ['Как включить анти дубль?', 'duplicates'],
      ['Как включить антидубль?', 'duplicates'],
      ['Как настроить антимат?', 'profanity-sensitivity'],
    ],
    ([text, expected]) => {
      assert.equal(eligibleQuestion(text), true, text);
      assert.equal(selectKnowledge(text)[0].id, expected, text);
    },
  );
});

test('role and community answers continue a recent assistant clarification', () => {
  const communityClarification = [
    { role: 'user', text: 'Объявление заблокировали' },
    { role: 'assistant', text: 'Это ваш чат или чужая группа?' },
  ];
  const confirmation = [
    { role: 'user', text: 'Не получается настроить антидубль' },
    { role: 'assistant', text: 'Вы администратор этого чата?' },
  ];
  const cases = [
    ...['Я администратор', 'Я админ', 'Я участник', 'Администратор'].map((text) => [
      text,
      roleClarification,
    ]),
    ...['В своём канале', 'В чужой группе', 'В моём чате'].map((text) => [
      text,
      communityClarification,
    ]),
    ...['Да', 'Нет'].map((text) => [text, confirmation]),
  ];
  checkCases(cases, ([text, history]) => assert.equal(eligibleQuestion(text, history), true, text));
});

test('role identity without a recent assistant clarification does not start a support exchange', () => {
  const unrelatedHistory = [
    { role: 'user', text: 'Как подключить бота?' },
    { role: 'assistant', text: 'Откройте настройки бота и проверьте права.' },
  ];
  const userQuestionOnly = [{ role: 'user', text: 'Вы участник группы или её администратор?' }];
  const staleClarification = [
    ...roleClarification,
    { role: 'user', text: 'Всем привет' },
    { role: 'assistant', text: 'Хорошего дня.' },
    { role: 'user', text: 'Сегодня воскресенье' },
    { role: 'assistant', text: 'Обсуждение завершено.' },
  ];
  for (const history of [[], unrelatedHistory, userQuestionOnly, staleClarification])
    for (const text of ['Я администратор', 'Я админ', 'В своём канале', 'Да', 'Нет'])
      assert.equal(eligibleQuestion(text, history), false, `${text}: ${JSON.stringify(history)}`);
});

test('gratitude, weather and ordinary advertisements remain silent even after clarification', () => {
  const texts = [
    'Спасибо',
    'Всем спасибо!',
    'Какая погода завтра?',
    'Всем доброе утро!',
    'Продам диван, недорого',
  ];
  const cases = [[], roleClarification].flatMap((history) => texts.map((text) => [text, history]));
  checkCases(cases, ([text, history]) =>
    assert.equal(eligibleQuestion(text, history), false, `${text}: ${JSON.stringify(history)}`),
  );
});

test('first-source priority keeps the relevant instruction when the context budget trims facts', () => {
  for (const [text, allowed] of [
    ['Как включить комментарии?', ['comments', 'channel-settings', 'max-native-channel-comments']],
    ['Как настроить подписку?', ['subscription']],
    ['Какой лимит видео в Публике?', ['publisher-post-media']],
  ]) {
    assert.equal(eligibleQuestion(text), true, text);
    const first = selectKnowledge(text)[0].id;
    assert.ok(allowed.includes(first), `${text}: ${first}`);
  }
  const publisherQuestion = 'Я администратор канала, как выложить рекламу через Публик?';
  assert.equal(eligibleQuestion(publisherQuestion), true);
  assert.ok(
    selectKnowledge(publisherQuestion)
      .slice(0, 4)
      .some((entry) => entry.id === 'publisher-post-create'),
  );
});

test('every routing variant retains support-room and operator policy exactly once', () => {
  for (const text of [
    'Как выложить обявление?',
    'Как настроить стопслова?',
    'Как включить комментарии?',
    'Как настроить подписку?',
    'Нужна помощь с настройками',
  ]) {
    const ids = selectKnowledge(text).map((entry) => entry.id);
    for (const mandatory of ['support-room', 'operator']) {
      assert.ok(knowledge.entries.some((entry) => entry.id === mandatory));
      assert.equal(ids.filter((id) => id === mandatory).length, 1, `${text}: ${mandatory}`);
    }
  }
});

test('source URL validation rejects case changes, relative hosts and alternate protocol tricks', () => {
  const connect = knowledge.entries.find((entry) => entry.id === 'connect');
  assert.ok(connect);
  for (const link of [
    'HTTPS://evil.example/login',
    'hTtPs://evil.example/login',
    '//evil.example/login',
    'www.evil.example',
    'https://major-maksimov.ru@evil.example/app/',
    'https://max.ru.evil.example/se14088825_bot',
    'javascript:alert(1)',
    'data:text/html,example',
    'file:///etc/passwd',
  ]) {
    const value = { action: 'reply', text: `[Проверить права](${link})`, sourceIds: [connect.id] };
    assert.throws(() => validateSupportAnswer(value, [connect]), /support_response_link/u, link);
  }
  for (const text of [
    'Откройте HTTPS://evil.example/login',
    'Откройте //evil.example/login',
    'Откройте www.evil.example',
  ])
    assert.throws(
      () => validateSupportAnswer({ action: 'reply', text, sourceIds: [connect.id] }, [connect]),
      /support_response_link/u,
      text,
    );
});

test('source URL validation still permits the known product links', () => {
  const connect = knowledge.entries.find((entry) => entry.id === 'connect');
  for (const link of ['https://major-maksimov.ru/app/', 'https://max.ru/se14088825_bot']) {
    const value = { action: 'reply', text: `Откройте ${link}`, sourceIds: [connect.id] };
    assert.equal(validateSupportAnswer(value, [connect]).action, 'reply');
  }
});
