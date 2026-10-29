import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSupportRouter } from './support-llm-routing.mjs';

const knowledge = JSON.parse(
  readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)),
);
const router = createSupportRouter(knowledge);
const ids = (text, history = []) => router.selectKnowledge(text, history).map((entry) => entry.id);
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

for (const module of knowledge.moduleCoverage ?? [])
  test(`catalog module: ${module.id}`, () => {
    const { text, requiredIds } = module.probe;
    assert.equal(router.classify(text).requiredReply, true, text);
    for (const id of requiredIds)
      assert.ok(ids(text).includes(id), `${id}: ${ids(text).join(', ')}`);
    for (const id of module.factIds) {
      const fact = knowledge.entries.find((entry) => entry.id === id);
      assert.ok(fact, id);
      for (const path of fact.sources.filter((path) => !path.startsWith('https://')))
        assert.ok(source(path).length, path);
    }
  });

test('the module inventory covers every shared chat and channel settings section', () => {
  const registry = source('apps/miniapp/src/pages/settings/settings-workspace-sections.ts');
  for (const [kind, constant] of [
    ['chat', 'CHAT'],
    ['channel', 'CHANNEL'],
  ]) {
    const block = registry
      .split(`export const NETWORK_${constant}_SETTINGS_SECTIONS = [`)[1]
      .split('] as const')[0];
    const actual = [...block.matchAll(/section: '(\w+)'/gu)].map((match) => match[1]).sort();
    const mapped = knowledge.moduleCoverage.flatMap((module) => module[`${kind}Sections`]).sort();
    assert.deepEqual(mapped, actual, kind);
  }
  const reviewed = knowledge.projectReview.source;
  assert.match(reviewed, /^[a-f0-9]{40}$/u);
  assert.equal(
    new Set(knowledge.moduleCoverage.map((module) => module.id)).size,
    knowledge.moduleCoverage.length,
  );
});

test('poll and giveaway limits and controls are grounded in the product contracts', () => {
  const fact = (id) => knowledge.entries.find((entry) => entry.id === id).answer;
  const poll = source('packages/contracts/src/poll.ts');
  for (const [constant, value] of [
    ['MIN_OPTIONS', '2'],
    ['MAX_OPTIONS', '6'],
    ['QUESTION_MAX_LENGTH', '2_000'],
    ['OPTION_MAX_LENGTH', '80'],
  ])
    assert.ok(poll.includes(`MANAGED_POLL_${constant} = ${value};`));
  assert.match(fact('poll-create'), /от 2 до 6.*2000.*80/u);
  assert.match(fact('poll-create'), /«Опросы» → «Новый»/u);
  assert.match(source('apps/miniapp/src/components/managed-poll-workspace.tsx'), />\s*Новый\s*</u);
  assert.match(fact('poll-voting'), /в том числе от администратора/u);
  assert.match(fact('poll-recovery'), /может создать дубль/u);
  assert.match(source('packages/contracts/src/giveaway.ts'), /MAX_PRIZES = 10/u);
  assert.match(fact('giveaway-create'), /от 1 до 10 мест и до 10 дополнительных каналов/u);
  assert.match(
    fact('giveaway-participation'),
    /заявка и подтверждённый допуск — разные состояния/u,
  );
  assert.match(fact('giveaway-results'), /от 1 до 336 часов/u);
});

const missingModuleCases = [
  ['Что вообще умеет Майор, какие есть модули?', 'project-modules'],
  ['Как запретить номера телефонов в моём чате?', 'phone-numbers'],
  ['Как включить доступ за приглашения?', 'invitation-access'],
  ['Бот может убирать свои сообщения через время?', 'service-messages-and-bots'],
  ['Как выгонять других ботов из группы?', 'service-messages-and-bots'],
  ['Антидубль: одинаковые картинки от разных людей тоже считает?', 'duplicates-photo'],
  ['Как запретить голосовые и пересылки в моём чате?', 'limits-attachments'],
  ['Жалобы: как удалить историю за 24 часа и ограничить автора?', 'reports-outcomes'],
  ['Где найти карточку участника моего чата?', 'participants'],
  ['Как оставить человека в чате, но на время без сообщений?', 'participant-mute'],
  ['Где посмотреть действующие ограничения и снять бан?', 'sanction-history'],
  ['В базе спама кнопка «Подтвердить спам» сразу удалит человека?', 'spammer-review'],
  ['Как посмотреть статистику моего чата за месяц?', 'chat-statistics'],
  ['Где посмотреть журнал удалений моего чата?', 'chat-events'],
  ['Как создать опрос с шестью вариантами?', 'poll-create'],
  ['В анонимном опросе видно, кто как проголосовал?', 'poll-voting'],
  ['Опрос завис: «Нужна проверка». Жать опубликовать заново?', 'poll-recovery'],
  ['Как создать розыгрыш на десять призовых мест?', 'giveaway-create'],
  [
    'Подписался, но розыгрыш пишет, что допуск не подтверждён. Что делать?',
    'giveaway-participation',
  ],
  ['Победитель розыгрыша не забрал приз. Как выбрать другого?', 'giveaway-results'],
  ['Как сделать кнопку под каждой публикацией канала?', 'channel-post-action'],
  ['Быстрые кнопки: что писать в строке нового поста?', 'channel-quick-buttons'],
  [
    'Предложения в канале: как выбрать отправку в боте и суточный лимит?',
    'channel-suggestions-entry',
  ],
  ['Мини-приложение пишет «Срок входа истёк», что делать?', 'miniapp-relaunch'],
  [
    'Хочу закрыть голосовухи и пересланные посты, а текст оставить. Где выключить?',
    'limits-attachments',
  ],
  ['В рекламе вижу ИИ, хочу сделать его помягче. Куда нажать?', 'commercial-ai-sensitivity'],
  [
    'Мне нужно, чтобы человек пригласил друзей, иначе писать нельзя. Эта функция уже включается?',
    'invitation-access',
  ],
  [
    'Участники хотят пожаловаться на пост. Что им написать боту, чтобы голос учёлся?',
    'community-reports',
  ],
  [
    'Модератор засоряет чат своими ответами. Можно чтоб они через время исчезали?',
    'service-messages-and-bots',
  ],
  [
    'В своём чате не нахожу человека. Где поиск по участникам и как открыть его настройки?',
    'participants',
  ],
  [
    'В ограничениях вижу «Проверить снятие в MAX». Эта кнопка сама разбанит человека?',
    'sanction-history',
  ],
  [
    'Подтвердил спам в очереди. Значит бот уже выгнал этого человека из всех моих чатов?',
    'spammer-review',
  ],
  ['Мне нужна сводка по группе за последние тридцать дней, где её смотреть?', 'chat-statistics'],
  [
    'Как понять по журналу, почему бот удалил конкретный пост? А если журнала вообще не вижу?',
    'chat-events',
  ],
  [
    'Надо, чтобы опубликованный через Публика пост сам удалился позже. Где это задаётся?',
    'publisher-after-publish',
  ],
  ['Есть готовый пост в MAX, как забрать его в редактор Публика?', 'publisher-import-max'],
  [
    'В Публике хочу ответ на ключевую фразу, но чтобы он не спамил каждым совпадением. Что настроить?',
    'publisher-auto-replies-matching',
  ],
  ['Посты VK хочу сначала себе на одобрение, а не сразу в канал. Как включить?', 'vk-review'],
];

for (const [text, expected] of missingModuleCases)
  test(`project module retrieval: ${expected}: ${text}`, () => {
    const route = router.classify(text);
    assert.equal(route.eligible, true);
    assert.equal(route.requiredReply, true);
    assert.ok(ids(text).includes(expected), `${expected}: ${ids(text).join(', ')}`);
  });

test('short followups retain the module, but completed tasks and ordinary conversation do not', () => {
  for (const [question, followup, expected] of [
    ['Как создать опрос?', 'А имена кто увидит?', 'poll-voting'],
    ['Как запустить розыгрыш?', 'А победителя можно заменить?', 'giveaway-results'],
    ['Где карточка участника?', 'А как временно запретить ему писать?', 'participant-mute'],
    ['Как включить быстрые кнопки?', 'А что писать в строке?', 'channel-quick-buttons'],
  ]) {
    const history = [{ role: 'user', text: question }];
    assert.equal(router.classify(followup, history).requiredReply, true, followup);
    assert.ok(ids(followup, history).includes(expected), followup);
  }
  const history = [{ role: 'user', text: 'Как запустить розыгрыш?' }];
  assert.ok(
    !ids('С розыгрышем разобрался. Теперь как создать опрос?', history).includes('giveaway-create'),
  );
  assert.equal(router.classify('Спасибо, получилось!', history).eligible, false);
});

test('module context does not replace an independent question or the support role boundary', () => {
  const combined = ids('Я админ: как создать опрос и подключить Ластика для старых сообщений?');
  assert.ok(combined.includes('poll-create'));
  assert.ok(combined.includes('lastik-connect'));
  for (const text of [
    'Я участник, куда выложить объявление?',
    'Почему снесли мою объяву в чужой группе?',
  ]) {
    assert.ok(
      !ids(text).some((id) => /^(?:poll|giveaway|participant-mute|project-modules)/u.test(id)),
    );
  }
  assert.equal(router.classify('Как приготовить борщ?').eligible, false);
  assert.ok(!ids('В Публике хочу автоответ, но чтобы не спамил.').includes('spammer-review'));
  assert.ok(!ids('Ластик сохраняет объявления розыгрышей?').includes('giveaway-create'));
});
