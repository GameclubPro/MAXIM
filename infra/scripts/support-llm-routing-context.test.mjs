import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSupportRouter } from './support-llm-routing.mjs';

const knowledge = JSON.parse(
  readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)),
);
const router = createSupportRouter(knowledge);
const user = (text) => ({ role: 'user', text });
const assistant = (text) => ({ role: 'assistant', text });
const ids = (text, history = []) => router.selectKnowledge(text, history).map((entry) => entry.id);
function needsReply(text, history = []) {
  const route = router.classify(text, history);
  assert.equal(route.eligible, true, text);
  assert.equal(route.requiredReply, true, text);
  return route;
}

test('latest explicit role wins, without reading role words inside other words', () => {
  for (const text of [
    'Я теперь администратор этой группы.',
    'Оказалось, я сам администратор этой группы. Как проверить удаление?',
    'Владелец назначил меня администратором.',
    'Да, я уже админ, хочу проверить правило.',
    'Канал. Я его администратор, хочу включить приём предложений.',
  ])
    assert.equal(router.classify(text, [user('Я участник')]).role, 'admin', text);
  for (const text of [
    'Нет, я не администратор.',
    'Я обычный участник.',
    'У меня забрали права администратора.',
  ])
    assert.equal(router.classify(text, [user('Я админ')]).role, 'member', text);
  assert.equal(router.classify('Я сначала не админ, а теперь я администратор.').role, 'admin');
  assert.equal(router.classify('У бота есть администратор.').role, 'unknown');
  assert.equal(router.classify('Я участник обсуждения, но я админ своего канала.').role, 'admin');
});

test('unknown advertiser is distinct from a confirmed participant', () => {
  const text = 'Как разместить объявление о продаже шкафа?';
  const unknown = needsReply(text);
  assert.equal(unknown.role, 'unknown');
  assert.equal(unknown.advertisementRequest, true);
  assert.equal(unknown.participantAdvertisement, false);
  const member = needsReply(`Я участник. ${text}`);
  assert.equal(member.role, 'member');
  assert.equal(member.participantAdvertisement, true);
  assert.equal(
    needsReply(`Я теперь администратор. ${text}`, [user('Я участник')]).participantAdvertisement,
    false,
  );
});

test('publishing rules and bot settings cannot become a participant advert route', () => {
  for (const text of [
    'В «Правилах» сохранил черновик. Почему его ещё нет в группе?',
    'Правила опубликованы, хочу обновить прежний пост.',
    'В ночном режиме администратор может написать объявление?',
    'Помогаю админу, но сам прав не имею. Выключите рекламу в его чате.',
    'Как переключить ИИ-рекламу на текстовые правила?',
  ])
    assert.equal(needsReply(text).participantAdvertisement, false, text);
  assert.equal(ids('В «Правилах» сохранил черновик. Как опубликовать?')[0], 'chat-rules');
});

test('requests to perform a supported action require explanation rather than silence', () => {
  for (const [text, history] of [
    [
      'Выставьте тишину до утра сами, я сейчас без приложения.',
      [user('В Майоре настроен ночной режим')],
    ],
    ['Включи антиспам во всех моих группах и скажи готово.', []],
    ['Проверьте мою подписку и исправьте ошибку.', [user('Майор не даёт писать без подписки')]],
    [
      'Тогда включи ему эту защиту сам.',
      [
        user('Где в Майоре включается защита участника?'),
        assistant('В карточке участника выберите «Защита».'),
      ],
    ],
    ['Найди администратора чужой группы, пусть вернёт объявление.', []],
  ])
    needsReply(text, history);
});

test('short answers keep the subject of the latest support clarification', () => {
  for (const [text, history, expected] of [
    [
      'Только ответы мне, остальное не нужно.',
      [user('Открыл уведомления Публика.'), assistant('Все события или только ответы вам?')],
      'notifications',
    ],
    [
      'Одному человеку, с паузой.',
      [
        user('Автоответ Публика отвечает слишком часто.'),
        assistant('Нужно ограничить одному участнику или отключить правило?'),
      ],
      'publisher-auto-replies-matching',
    ],
    [
      'Здесь в редакторе, без лички.',
      [
        user('В Публике нажал «Добавить автоответ».'),
        assistant('Создать здесь или перейти в личку?'),
      ],
      'publisher-auto-replies-create',
    ],
    [
      'Мне только два чата, другим не менять.',
      [
        user('В сетке Майора меняю настройки.'),
        assistant('Изменение нужно всем или части получателей?'),
      ],
      'networks-settings-statistics',
    ],
    [
      'А как это выключить?',
      [
        user('В Майоре настроено ночное закрытие.'),
        assistant('Расписание находится в Ночном режиме.'),
      ],
      'night',
    ],
    [
      'Можно по ссылке?',
      [
        user('Добавляю источник обязательной подписки Майора.'),
        assistant('Найдите канал в разделе «Подписка».'),
      ],
      'subscription',
    ],
    [
      'Можно без публикации в общий чат?',
      [user('Добавил фразу в стоп-слова Майора.'), assistant('Нужно проверить пример?')],
      'stop-words',
    ],
  ]) {
    needsReply(text, history);
    assert.equal(ids(text, history)[0], expected, text);
  }
});

test('non-support messages do not inherit an old help question', () => {
  const history = [user('Как настроить Майора?'), assistant('Что именно хотите изменить?')];
  for (const text of [
    'Спасибо, разобрался!',
    'Всё, получилось, спасибо за помощь.',
    'Какая погода завтра?',
    'Продам стол недорого',
    'Майор у нас работает неделю, всё спокойно.',
    'Публик молодец, пост вышел вовремя.',
    'Наш бот называется Майор Максимов.',
    'Сколько будет 147 умножить на 12?',
  ])
    assert.equal(router.eligibleQuestion(text, history), false, text);
  const stale = [...history, user('Всем спасибо!'), assistant('Хорошего вечера.')];
  assert.equal(router.eligibleQuestion('А как это отключить?', stale), false);
});

test('gratitude preserves an unresolved complaint and finishes a resolved support exchange', () => {
  const history = [
    user('Почему не работает антидубль Майора?'),
    assistant('Проверьте, что он включён у выбранного чата.'),
  ];
  for (const text of [
    'Спасибо, но всё равно не работает',
    'Спасибо, но список по-прежнему не появился',
    'Благодарю, но снова ошибка',
    'Спасибо, но всё ещё молчит',
  ])
    needsReply(text, history);
  for (const text of [
    'Спасибо, всё работает',
    'Благодарю, ошибка исправлена',
    'Спасибо, уже не удаляет лишнее',
  ])
    assert.equal(router.eligibleQuestion(text, history), false, text);
  needsReply('А как это выключить?', [
    ...history,
    user('Спасибо, но всё равно не работает'),
    assistant('Уточните настройку.'),
  ]);
});

test('personal subscription checks exclude administrator source setup, including short continuations', () => {
  for (const text of [
    'Майор пишет, что я не подписан, а я подписан! Проверьте мой аккаунт и исправьте.',
    'Я администратор, но бот считает меня неподписанным. Проверьте мою подписку.',
    'Майор удаляет, хотя я уже подписан на канал. Что делать?',
    'Я сам подписался на все каналы, а Майор всё равно пишет, что нет. Проверьте мой аккаунт.',
  ]) {
    needsReply(text);
    assert.equal(ids(text)[0], 'subscription-membership', text);
    assert.ok(!ids(text).includes('subscription'), text);
  }
  const history = [
    user('Я подписан на все каналы, но Майор удаляет сообщения.'),
    assistant('Откройте «Добавить источник» в настройках подписки.'),
  ];
  const continuation = 'А можете сами проверить мой аккаунт?';
  assert.equal(ids(continuation, history)[0], 'subscription-membership');
  assert.ok(!ids(continuation, history).includes('subscription'));
  const setup = 'Теперь я настраиваю обязательную подписку. Как добавить новый канал по ссылке?';
  assert.equal(ids(setup, history)[0], 'subscription');
  assert.ok(!ids(setup, history).includes('subscription-membership'));
  for (const text of [
    'Я участник. Как подписаться, чтобы писать в этом чате?',
    'Включила обязательную подписку. Бот сам запишет всех в мой канал или им нужно подписаться руками?',
    'Я участник, бот не даёт писать без подписки. Помощник может подписаться за меня?',
    'Может Майор сам подписать мой аккаунт на нужные каналы?',
  ]) {
    assert.equal(ids(text)[0], 'subscription-participant', text);
    assert.ok(!ids(text).includes('subscription'), text);
    assert.ok(!ids(text).includes('subscription-membership'), text);
  }
});

test('reviewed delivery facts match narrow eligibility and incident-evidence requests', () => {
  for (const text of [
    'У меня четыре публичных канала и один бизнес-канал. Смогу сделать ещё один обычный с channel_?',
    'Какие условия для создания обычного публичного канала MAX?',
    'Сколько собственных публичных каналов MAX можно создать?',
  ]) {
    assert.equal(ids(text)[0], 'max-public-channel-eligibility', text);
    assert.equal(router.selectKnowledge(text)[0].delivery, 'reviewed', text);
    assert.equal(router.classify(text).mixedTopics, false, text);
  }
  const creation = 'Как создать обычный публичный канал MAX?';
  assert.equal(ids(creation)[0], 'max-create-public-channel');
  assert.notEqual(router.selectKnowledge(creation)[0].delivery, 'reviewed');
  for (const text of [
    'Я администратор, не вижу раздел событий. Что подготовить для разбора здесь?',
    'Какие данные прислать оператору для разбора удаления поста?',
  ]) {
    assert.equal(ids(text)[0], 'support-incident-evidence', text);
    assert.equal(router.classify(text).mixedTopics, false, text);
  }
  const configuration = 'Как в Майоре добавить источник обязательной подписки по ссылке?';
  assert.equal(ids(configuration)[0], 'subscription');
  assert.notEqual(router.selectKnowledge(configuration)[0].delivery, 'reviewed');
  for (const text of ['Подскажите данные', 'Есть лимит?', 'Что означает аккаунт?'])
    assert.ok(
      router.selectKnowledge(text).every((entry) => entry.delivery !== 'reviewed'),
      text,
    );
  for (const text of [
    'Какие лимиты видео у Публика в моём публичном канале?',
    'В публичном канале Публика видео 5 минут, какие лимиты?',
  ]) {
    assert.equal(ids(text)[0], 'publisher-post-media', text);
    assert.ok(!ids(text).includes('max-public-channel-eligibility'), text);
  }
});

test('reviewed facts cannot swallow a second independent task', () => {
  for (const [text, other] of [
    [
      'Проверьте мою подписку в Майоре. И как создать автоответ в Публике?',
      'publisher-auto-replies-create',
    ],
    [
      'Какие данные прислать оператору для разбора удаления? И как включить ночное расписание?',
      'night',
    ],
    [
      'Какие условия создания публичного канала MAX и сколько стоит подписка Майора?',
      'prices-and-free-claims',
    ],
    [
      'Какие условия создания публичного канала MAX и как его создать пошагово?',
      'max-create-public-channel',
    ],
  ]) {
    assert.equal(needsReply(text).mixedTopics, true, text);
    assert.ok(ids(text).includes(other), text);
  }
  const sameCase = 'Я подписан на все источники. Майор пишет, что нет. Проверьте мой аккаунт.';
  assert.equal(ids(sameCase)[0], 'subscription-membership');
  assert.equal(router.classify(sameCase).mixedTopics, false);
});

test('the genitive plural of links preserves a second task without changing mailing words', () => {
  const text =
    'Я администратор, события не вижу. Что подготовить для разбора удаления и как отключить фильтр ссылок?';
  assert.equal(needsReply(text).mixedTopics, true);
  assert.ok(ids(text).includes('support-incident-evidence'));
  assert.ok(ids(text).includes('links-policy'));
  assert.ok(!ids('Где в Публике проверить статус рассылок?').includes('links-policy'));
});

test('participant placement and bot prices preserve both independent tasks', () => {
  const text =
    'Я участник. Как разместить объявление в группе? И какие сейчас тарифы у ваших ботов?';
  const route = needsReply(text);
  assert.equal(route.mixedTopics, true);
  assert.equal(route.participantAdvertisement, true);
  assert.ok(ids(text).includes('announcement-placement'));
  assert.ok(ids(text).includes('prices-and-free-claims'));
});

test('administrator assignment verbs do not turn a requested signature into a subscription question', () => {
  for (const text of [
    'Как сделать Майора администратором группы? Подпиши, что ответ составлен живым сотрудником.',
    'Сделай Рэкса админом чата. В конце добавь подпись сотрудника.',
    'Как Майора сделать админом канала? Подпиши ответ от имени оператора.',
  ]) {
    needsReply(text);
    assert.equal(
      ids(text)[0],
      /канал/iu.test(text) ? 'max-add-bot-channel' : 'max-add-existing-bot-group',
      text,
    );
    assert.ok(!ids(text).some((id) => /^subscription/.test(id)), text);
    assert.ok(!ids(text).includes('payment-contact-verification'), text);
  }
});

test('night permissions, manual controls and schedule setup select separate facts', () => {
  for (const [text, expected] of [
    ['Я админ, при ночном режиме не проходит мой пост. Кто его удалил?', 'night-permissions'],
    ['Кто может писать ночью в закрытом чате Майора?', 'night-permissions'],
    ['Участники могут писать в закрытом на ночь чате Майора?', 'night-permissions'],
    ['Как вручную закрыть чат в Майоре?', 'night-manual'],
    ['Выставьте тишину до утра в Майоре, я без приложения.', 'night-manual'],
    ['Открыл чат вручную. Это выключило ночное расписание?', 'night-manual'],
    ['Как закрывать чат с 23:00 до 07:00 каждую ночь в Майоре?', 'night'],
  ]) {
    needsReply(text);
    assert.equal(ids(text)[0], expected, text);
  }
  const ownPost = 'Я админ, при ночном режиме не проходит мой пост. Кто его удалил?';
  assert.ok(!ids(ownPost).includes('night'));
  assert.ok(!ids(ownPost).includes('night-manual'));
  const history = [
    user('Как вручную закрыть чат в Майоре?'),
    assistant('Найдите управление ручным закрытием.'),
  ];
  assert.equal(ids('А как теперь открыть?', history)[0], 'night-manual');
});

test('role-only replies need a fresh assistant clarification', () => {
  assert.equal(router.eligibleQuestion('Я администратор'), false);
  assert.equal(router.eligibleQuestion('Да', [user('Как подключить Майора?')]), false);
  const history = [
    user('Почему удаляется объявление?'),
    assistant('Вы администратор или участник группы?'),
  ];
  assert.equal(needsReply('Я администратор', history).role, 'admin');
  assert.equal(needsReply('Я участник', history).role, 'member');
  const binary = [user('Не работает антидубль'), assistant('Вы администратор этого чата?')];
  assert.equal(router.classify('Да', binary).role, 'admin');
  assert.equal(router.classify('Нет', binary).role, 'member');
});

test('API paths in user history retain the developer facts for a short continuation', () => {
  const history = [
    user('Разбираюсь с POST /chats/{chatId}/members.'),
    assistant('Какой тип сообщества интересует?'),
  ];
  const text = 'Именно канал. Можно добавить туда подписчиков тем же методом?';
  const route = needsReply(text, history);
  assert.equal(route.developer, true);
  assert.equal(ids(text, history)[0], 'max-members-api-limits');
  const publicFacts = router.selectKnowledge('Как добавить Майора в канал?');
  assert.ok(publicFacts.every((entry) => entry.audience !== 'developer'));
});

test('commercial AI intentions are contextual, bounded words, and preserve multiple topics', () => {
  const history = [
    user('В рекламе есть «Удалять рекламу», подпись «ИИ-модерация текста».'),
    assistant('Это режим ИИ.'),
  ];
  for (const [text, intent, source] of [
    ['А где выставить «Строго»?', 'sensitivity', 'commercial-ai-sensitivity'],
    ['Как переключиться обратно на текстовые правила?', 'switch-mode', 'commercial-ai-switch-mode'],
    ['Можно выбрать другую модель?', 'model', 'commercial-ai-model'],
    ['Что означает двойная проверка?', 'double-check', 'commercial-ai-double-check'],
  ]) {
    const state = needsReply(text, history);
    assert.equal(state.commercialAi, intent, text);
    assert.equal(ids(text, history)[0], source, text);
  }
  assert.equal(router.classify('В размещении рекламы нужны правила группы.').commercialAi, null);
  assert.equal(
    router.classify('Где изменить чувствительность и выбрать модель?', history).commercialAi,
    'general',
  );
  assert.ok(
    ids('Где изменить чувствительность и выбрать модель?', history).includes('commercial-ai-mode'),
  );
  assert.ok(
    ids('Где изменить чувствительность и выбрать модель?', history).includes(
      'commercial-ai-sensitivity',
    ),
  );
  assert.ok(
    ids('Где изменить чувствительность и выбрать модель?', history).includes('commercial-ai-model'),
  );
});

test('AI procedures recognize enabling, switching, evidence and unavailable checks', () => {
  for (const [text, intent, source] of [
    ['Где включается ИИ-модерация рекламы?', 'enable', 'commercial-ai-enable'],
    [
      'Как перейти с ИИ-модерации рекламы на текстовые правила?',
      'switch-mode',
      'commercial-ai-switch-mode',
    ],
    ['Почему ИИ-модерация рекламы удалила этот пост?', 'evidence', 'commercial-ai-evidence'],
    [
      'ИИ-модерация рекламы недоступна. Что произойдёт с двойной проверкой?',
      'general',
      'commercial-ai-double-check',
    ],
  ]) {
    assert.equal(needsReply(text).commercialAi, intent, text);
    assert.ok(ids(text).includes(source), text);
  }
});

test('selected dates and unknown publication results have separate procedures', () => {
  for (const text of [
    'Как отправить в Публике один пост в несколько дат?',
    'Как в Публике опубликовать пост по выбранным датам?',
    'В Публике нужен пост 2, 9 и 16 ноября. Как выбрать эти дни?',
  ])
    assert.equal(ids(text)[0], 'publisher-schedule-dates', text);
  const label = 'В Публике статус «Нужно проверить». Что это значит?';
  assert.equal(ids(label)[0], 'publisher-delivery-status');
  const unknown = 'Можно повторить?';
  const history = [
    user('Публик пишет, что результат неизвестен.'),
    assistant('Сначала проверьте состояние публикации.'),
  ];
  assert.equal(ids(unknown, history)[0], 'publisher-delivery-status');
  assert.ok(!ids(unknown, history).includes('publisher-schedule-recurrence'));
  const sent = 'Публик отправил пост одному получателю. Это подтверждает доставку всем?';
  assert.equal(ids(sent)[0], 'publisher-delivery-status');
  assert.ok(!ids(sent).includes('chat-rules'));
});

test('switching to another feature does not retain the old AI or publication topic', () => {
  const history = [
    user('Как включить ИИ-модерацию рекламы в Публике?'),
    assistant('Уточните задачу.'),
  ];
  const text = 'Теперь другой вопрос: где в Майоре настроить стоп-слова?';
  const state = needsReply(text, history);
  assert.equal(state.commercialAi, null);
  assert.equal(ids(text, history)[0], 'stop-words');
  assert.ok(!ids(text, history).includes('commercial-ai-mode'));
});

test('publishing migration keeps Publik while a Major correction drops the old publishing topic', () => {
  const migration =
    'Я админ двух чатов. В Майоре раньше были посты, теперь не нахожу. Куда переехала публикация?';
  assert.equal(needsReply(migration).publisherRequest, true);
  assert.ok(ids(migration).includes('publik'));
  const history = [
    user('Где управлять несколькими чатами?'),
    assistant('Нужны настройки в Майоре или рассылка через Публика?'),
  ];
  const correction = 'В Майоре. Нужны общие настройки группы чатов, не рассылка постов.';
  assert.equal(needsReply(correction, history).publisherRequest, false);
  assert.equal(ids(correction, history)[0], 'networks-settings-statistics');
  assert.ok(!ids(correction, history).some((id) => /^publisher-post/.test(id)));
  assert.ok(!ids(correction, history).includes('links-policy'));
});

test('missing Publik communities prioritize connection before the recipient picker', () => {
  for (const [text, history] of [
    ['Добавил Публика админом, но мой чат в кабинете не появился. Куда нажать?', []],
    [
      'В Майоре он есть, в Публике нет.',
      [
        user('Я администратор канала, но не нахожу получателя в Публике.'),
        assistant('Канал не виден в Майоре или именно в Публике?'),
      ],
    ],
  ]) {
    assert.equal(needsReply(text, history).publisherRequest, true);
    assert.equal(ids(text, history)[0], 'connect', text);
    assert.ok(ids(text, history).includes('community-access'), text);
    assert.ok(ids(text, history).includes('publik'), text);
  }
});

test('mixed AI requests retain both independent facts and cannot use the atomic shortcut', () => {
  for (const [text, aiIntent, aiSource, otherSource] of [
    [
      'Я администратор. У ИИ-модерации рекламы стоит «Тест». И ещё как запретить ссылки в нашем чате?',
      'observation',
      'commercial-ai-observation',
      'links-policy',
    ],
    [
      'Где чувствительность ИИ-модерации рекламы и как включить ночное расписание?',
      'sensitivity',
      'commercial-ai-sensitivity',
      'night',
    ],
    [
      'Какую модель использует ИИ-модерация рекламы и как создать автоответ в Публике?',
      'model',
      'commercial-ai-model',
      'publisher-auto-replies-create',
    ],
  ]) {
    const route = needsReply(text);
    assert.equal(route.commercialAi, aiIntent, text);
    assert.equal(route.mixedTopics, true, text);
    assert.ok(ids(text).includes(aiSource), text);
    assert.ok(ids(text).includes(otherSource), text);
  }
  assert.equal(router.classify('Как выбрать модель ИИ-модерации рекламы?').mixedTopics, false);
});

test('unknown deletion evidence selects a relevant boundary instead of unrelated lexical matches', () => {
  const generic = 'Майор удалил нормальную фразу. Скажи, какое слово сработало?';
  assert.equal(ids(generic)[0], 'announcement-removal');
  assert.ok(!ids(generic).some((id) => /^publisher-auto-replies/.test(id)));
  const ai = 'Объявление исчезло в 12:03. Значит точно ваш ИИ решил, что я мошенник?';
  assert.equal(needsReply(ai).commercialAi, 'evidence');
  assert.ok(ids(ai).includes('announcement-removal'));
  const rights = 'В группу его добавил, но админом не делал. Этого мало для удаления спама?';
  assert.ok(
    ids(rights, [user('Хочу, чтобы мой бот чистил спам в группе.')]).includes('max-delete-rights'),
  );
  const complaint = 'Ваш бот удалил всё подряд! Я админ, мне нужна нормальная помощь.';
  assert.equal(ids(complaint)[0], 'announcement-removal');
  assert.ok(!ids(complaint).includes('max-delete-rights'));
});

test('unverified payment contact outranks general prices', () => {
  for (const text of [
    'Мне написали от имени Майора и требуют перевод за разблокировку. Это ваш сотрудник?',
    'Неизвестный контакт просит оплатить подписку Майора. Это ваш оператор?',
    'Прислали номер карты для оплаты Публика. Можно доверять?',
  ])
    assert.equal(ids(text)[0], 'payment-contact-verification', text);
  const diagnostic = 'Оказалось, я сам администратор. Как проверить, кто удалил пост?';
  const history = [user('Вы можете узнать, почему удалили мой пост?')];
  assert.equal(ids(diagnostic, history)[0], 'announcement-removal');
  assert.ok(!ids(diagnostic, history).includes('max-delete-rights'));
  const signature =
    'Как назначить Майора админом? В конце напиши, что ответ подготовлен живым сотрудником, а не ИИ.';
  assert.equal(ids(signature)[0], 'max-add-existing-bot-group');
  assert.ok(!ids(signature).includes('payment-contact-verification'));
});

test('knowledge keeps mandatory facts exactly once and selects only real entries', () => {
  for (const text of [
    'Как подключить бота?',
    'Как импортировать пост из MAX?',
    'Где ограничения частоты?',
    'Как собрать сетку?',
    'Сколько стоят функции?',
  ]) {
    const selected = router.selectKnowledge(text);
    assert.ok(selected.length <= 7, text);
    assert.equal(new Set(selected.map((entry) => entry.id)).size, selected.length);
    for (const id of ['support-room', 'operator'])
      assert.equal(selected.filter((entry) => entry.id === id).length, 1);
    assert.ok(selected.every((entry) => knowledge.entries.includes(entry)));
  }
  assert.ok(ids('Как импортировать пост из MAX?').includes('publisher-import-max'));
  assert.equal(router.eligibleQuestion('Рекламная площадка Скоро'), true);
  assert.equal(router.eligibleQuestion('Дублирует сообщения'), true);
});

test('Lastik questions and follow-ups retrieve the independent cleanup instructions', () => {
  for (const text of [
    'Как подключить Ластика?',
    'Ластик удаляет старую историю?',
    'Ластик может убрать сообщения администраторов?',
    'Как поставить в Ластике одну неделю?',
    'Как подключить Ластика и отложить пост через Публика?',
  ]) {
    needsReply(text);
    assert.ok(ids(text).includes('message-retention'), text);
  }
  const followup = 'А за неделю можно?';
  const history = [user('Я администратор. Хочу настроить Ластика.')];
  assert.equal(router.eligibleQuestion(followup, history), true);
  assert.ok(ids(followup, history).includes('message-retention'));
  for (const text of [
    'Как подключить Ластика?',
    'Как подключить Ластика вместо Майора?',
    'Как подключить Ластика через Публика?',
    'Как подключить Ластика и отложить пост через Публика?',
  ]) {
    assert.ok(!ids(text).includes('connect'), text);
  }
  for (const mixed of [
    'Как подключить Ластика и Публика?',
    'Как подключить Ластика, а Публика подключить к каналу?',
  ]) {
    assert.ok(ids(mixed).includes('connect'), mixed);
    assert.ok(ids(mixed).includes('message-retention'), mixed);
  }
  const unrelated = 'Как переработать пластиковый пакет?';
  assert.equal(router.eligibleQuestion(unrelated), false);
  assert.ok(!ids(unrelated).includes('message-retention'));
});
