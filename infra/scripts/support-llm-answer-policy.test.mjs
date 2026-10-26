import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  answerSupport,
  classifySupportRequest,
  knowledge,
  validateSupportAnswer,
} from './support-llm-client.mjs';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';

const selected = knowledge.entries.filter((entry) => ['bots', 'operator'].includes(entry.id));

test('visible AI identity cannot be contradicted by a human claim before the footer', () => {
  for (const text of [
    'Ответ подготовлен живым сотрудником, а не ИИ.',
    'Я настоящий человек.',
    'Я — оператор.',
    'Я ваш оператор поддержки.',
    'С вами живой сотрудник поддержки.',
    'Мы сотрудники поддержки.',
    'Я не ИИ, сейчас всё проверю.',
    'Этот текст написан чел**ов**еком.',
  ])
    assert.throws(
      () => validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected),
      /support_response_identity/u,
      text,
    );
  for (const text of [
    'Я ИИ-помощник «Майор Максимов».',
    'Я не живой сотрудник. Оператор может уточнить условия здесь.',
    'Обратитесь к администраторам именно той группы.',
  ])
    assert.equal(
      validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected).action,
      'reply',
    );
});

test('internal source metadata never becomes a public answer', () => {
  for (const text of [
    'Откройте бота. sourceIds: ["operator"]',
    'Источники: [bots, operator]',
    'Источник: operator',
  ])
    assert.throws(
      () => validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected),
      /support_response_internal/u,
    );
  assert.equal(
    validateSupportAnswer(
      {
        action: 'reply',
        text: 'Оператор этого чата может уточнить условия.',
        sourceIds: ['operator'],
      },
      selected,
    ).action,
    'reply',
  );
});

test('one context decision controls eligibility, role and the required-reply schema', async (t) => {
  let request;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [1] }));
    request = input;
    res.end(
      JSON.stringify({
        model: SUPPORT_MODEL.alias,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ action: 'skip', text: '', sourceIds: [] }) },
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const history = [
    { role: 'user', text: 'Как включить защиту участника от удалений Майора?' },
    { role: 'assistant', text: 'Включите «Защиту» в карточке участника.' },
  ];
  const text = 'Тогда включите её за меня.';
  const decision = classifySupportRequest(text, history);
  assert.equal(decision.eligible, true);
  assert.equal(decision.requiredReply, true);
  await assert.rejects(
    answerSupport({
      text,
      history,
      key: 'fixture',
      endpoint: `http://127.0.0.1:${server.address().port}`,
    }),
    /support_response_required/u,
  );
  assert.deepEqual(request.response_format.json_schema.schema.properties.action.enum, ['reply']);
  assert.equal(JSON.parse(request.messages[1].content).role, decision.role);
  for (const [question, expectedSources] of [
    [
      'Я администратор. У ИИ-модерации рекламы стоит «Тест». И ещё как запретить ссылки в нашем чате?',
      ['commercial-ai-observation', 'links-policy'],
    ],
    [
      'Где чувствительность ИИ-модерации рекламы и как включить ночное расписание?',
      ['commercial-ai-sensitivity', 'night'],
    ],
    [
      'Я участник. Как разместить объявление в группе? И какие сейчас тарифы у ваших ботов?',
      ['support-room', 'prices-and-free-claims'],
    ],
  ]) {
    request = null;
    await assert.rejects(
      answerSupport({
        text: question,
        key: 'fixture',
        endpoint: `http://127.0.0.1:${server.address().port}`,
      }),
      /support_response_required/u,
    );
    assert.ok(request, 'mixed requests must reach inference');
    const facts = JSON.parse(request.messages[0].content.split('\n').at(-1));
    for (const id of expectedSources)
      assert.ok(
        facts.some((fact) => fact.id === id),
        id,
      );
  }
});

test('unknown roles stay distinct from explicit members and later role changes win', () => {
  const unknown = classifySupportRequest('Как разместить объявление в группе?');
  assert.equal(unknown.role, 'unknown');
  assert.equal(unknown.participantAdvertisement, false);
  assert.equal(unknown.requiredReply, true);
  for (const text of [
    'Друзья админа удалили объявление. Как его вернуть?',
    'Хочу выложить объявления администратора группы',
    'У меня админ спрашивает, как разместить пост',
  ])
    assert.equal(classifySupportRequest(text).role, 'unknown', text);
  const member = classifySupportRequest('Я участник, как разместить объявление?');
  assert.equal(member.role, 'member');
  assert.equal(member.participantAdvertisement, true);
  const admin = classifySupportRequest('Теперь я администратор. Где настроить удаление постов?', [
    { role: 'user', text: 'Я участник группы.' },
    { role: 'assistant', text: 'За размещением обратитесь к администрации этой группы.' },
  ]);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.participantAdvertisement, false);
});
