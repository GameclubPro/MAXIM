import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { knowledge, validateSupportAnswer } from './support-llm-client.mjs';

const entries = new Map(knowledge.entries.map((entry) => [entry.id, entry]));
const fact = (id) => {
  assert.ok(entries.has(id), id);
  return entries.get(id).answer;
};
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('reviewed answers and link examples pass the public response boundary', () => {
  for (const entry of entries.values()) {
    assert.doesNotMatch(entry.answer, /https?:\/\/\S*[<>]|<botName>/iu, entry.id);
    assert.doesNotThrow(
      () =>
        validateSupportAnswer({ action: 'reply', text: entry.answer, sourceIds: [entry.id] }, [
          entry,
        ]),
      entry.id,
    );
  }
});

test('customer facts contain no instructions addressed to the model', () => {
  for (const entry of entries.values())
    assert.doesNotMatch(
      entry.answer,
      /не обещ(?:ай|ать)|не выдум(?:ывай|ывать)|не запрашивай|вежливо объясни|помоги по инструкции|не смешивать|не путайте|не переносите|надо подтверждать|технические детали давать|никогда не просить|\bsourceIds\b/iu,
      entry.id,
    );
  assert.match(fact('prices-and-free-claims'), /нет подтвержд[её]нной информации/iu);
  assert.match(fact('operator'), /у помощника нет подтвержд[её]нных текущих тарифов/iu);
  assert.match(fact('payment-contact-verification'), /нельзя установить.*мошенником/iu);
});

test('ordinary channel eligibility counts the business and A+ routes together', () => {
  const answer = fact('max-create-public-channel');
  for (const required of [
    /все три условия/iu,
    /российский номер/iu,
    /Цифровой ID/u,
    /менее пяти/iu,
    /в общее число.*через платформу.*для бизнеса.*А\+/iu,
  ])
    assert.match(answer, required);
  assert.doesNotMatch(answer, /бизнес.канал.{0,20}не учитыва/iu);
  assert.ok(
    entries
      .get('max-create-public-channel')
      .sources.some((source) => source === 'https://dev.max.ru/docs/channels/create'),
  );
});

test('schedule timezone facts match the displayed device timezone implementation', () => {
  assert.match(
    source('apps/miniapp/src/lib/broadcast-schedule.ts'),
    /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone \|\| 'Europe\/Moscow'/u,
  );
  assert.match(
    source('apps/miniapp/src/pages/publications-page.tsx'),
    /publication-schedule-timezone/u,
  );
  const answer = fact('publisher-schedule-timezone');
  assert.match(answer, /устройства или браузера/iu);
  assert.match(answer, /показанн.{0,10} пояс/iu);
  assert.match(answer, /отдельного меню.*нет/iu);
  const dates = fact('publisher-schedule-dates');
  assert.match(dates, /одного и того же содержимого/iu);
  assert.match(dates, /Сохранить расписание/u);
  assert.match(dates, /разных текстов.*отдельные публикации/iu);
});

test('network operation outcomes and audience coverage have separate facts', () => {
  const operation = fact('networks-settings-statistics');
  assert.match(operation, /Проверить изменения.*Применить/u);
  assert.match(operation, /результат отдельно по целям/iu);
  assert.match(operation, /ошибка отдельной цели не означает откат/iu);
  assert.doesNotMatch(operation, /7 или 30|неполной истории прироста/iu);
  const audience = fact('networks-audience-statistics');
  assert.match(audience, /7 или 30 дней/u);
  assert.match(audience, /покрытие только указанной части/iu);
  assert.doesNotMatch(audience, /нажмите.*Применить|ошибк.{0,20}из.за/iu);
});

test('Lastik instructions match current history coverage, periods and protected exceptions', () => {
  const answer = fact('message-retention');
  const ui = source('apps/miniapp/src/pages/settings/shared-message-retention-fields.tsx');
  for (const label of ['Ластик', 'Удаление по сроку', '24 часа', '48 часов', '1 неделя']) {
    assert.ok(ui.includes(label), label);
    assert.ok(answer.includes(label), label);
  }
  assert.match(answer, /администратором с правами чтения и удаления/u);
  assert.match(answer, /всю доступную историю, включая сообщения до включения/u);
  assert.match(answer, /сообщения любых авторов/u);
  assert.match(answer, /редактирование его не продлевает/u);
  assert.match(answer, /Исключения: закрепы, правила, объявления розыгрышей и их итоги/u);
  assert.match(ui, /сообщения любых авторов из всей доступной истории/u);
  assert.doesNotMatch(answer, /историю не очищает|учёт начинается заново|ждёт низкой нагрузки/u);
  assert.match(answer, /не видит, подключён ли Ластик/u);
});

test('AI intents preserve their own limits instead of an entire mixed FAQ', () => {
  assert.match(fact('commercial-ai-enable'), /Удалять рекламу.*сохраните/u);
  assert.doesNotMatch(fact('commercial-ai-enable'), /Мягко|Двойная проверка|мут/u);
  assert.match(fact('commercial-ai-sensitivity'), /чувствительность ИИ не настраивается/u);
  assert.match(fact('commercial-ai-switch-mode'), /нет пользовательского переключателя/u);
  assert.match(fact('commercial-ai-observation'), /другие фильтры.*могут.*удалять/iu);
  const aiPolicy = fact('commercial-ai-double-check');
  const commercialUi = source(
    'apps/miniapp/src/pages/settings/shared-commercial-settings-fields.tsx',
  );
  for (const label of [
    'Реклама подтверждена',
    'Удаление',
    'Результат неоднозначен',
    'Сохранение',
  ]) {
    assert.ok(commercialUi.includes(label), label);
    assert.ok(aiPolicy.includes(label), label);
  }
  assert.match(aiPolicy, /неоднозначном результате.*сообщение остаётся/u);
  assert.doesNotMatch(fact('commercial-ai-model'), /Подпись «Сомнения проверяет/u);
  assert.match(fact('commercial-ai-model'), /нет выбора модели/u);
  assert.match(fact('commercial-ai-evidence'), /не подтверждает проверку или удаление/u);
  assert.match(fact('commercial-sanctions'), /без.*предупреждений.*мутов.*банов/u);
});

test('delivery, readiness and notification instructions keep their distinct meanings', () => {
  assert.match(
    fact('publisher-post-targets'),
    /Новое сообщество через эту карточку не подключается/u,
  );
  assert.match(fact('publisher-post-targets'), /вообще нет в списке.*перешлите пост.*Публика/u);
  assert.match(fact('publisher-readiness'), /«Модуль выключен» и «Публик выключен».*разные/u);
  assert.match(fact('publisher-delivery-status'), /повторная отправка.*может создать дубль/iu);
  assert.match(fact('notifications'), /отдельного списка выбора.*нет/iu);
  assert.match(fact('notifications'), /отключения одного канала.*«Выкл» и «Канал»/iu);
  assert.match(fact('publisher-auto-replies-matching'), /только «прайс».*выключают/u);
  assert.match(fact('vk-review'), /у канала один согласующий/iu);
  assert.match(fact('vk-review'), /копии карточек не распределяются/iu);
  assert.match(fact('vk-review'), /В карточке поста нет выбора другого согласующего/u);
});

test('subscription steps and report subjects match their actual boundaries', () => {
  const subscription = fact('subscription');
  assert.match(subscription, /настройки нужного чата → «Подписка»/u);
  assert.match(subscription, /Добавить источник.*Добавить по ссылке.*Добавить/u);
  const subscriptionUi = source(
    'apps/miniapp/src/pages/settings/settings-required-subscription-ui.tsx',
  );
  for (const label of ['Добавить источник', 'Добавить по ссылке', 'Добавить'])
    assert.ok(subscriptionUi.includes(label), label);

  const reports = fact('community-reports');
  assert.match(reports, /Возраст сообщения.*меньше 24 часов/u);
  assert.match(reports, /24 часа и старше жалобы не принимаются/u);
  assert.match(reports, /Автор жалобы:.*не менее 24 часов/u);
  assert.match(reports, /Автор сообщения.*администраторов и защищённых участников/u);
  assert.match(reports, /не запрещает администраторам подавать жалобы/u);

  const eligibility = source('apps/api/src/moderation/reports/report.util.ts').split(
    'export function isEligibleReporter(',
  )[1];
  assert.ok(eligibility);
  assert.doesNotMatch(eligibility, /isAdmin|isOwner/u);
  assert.match(eligibility, /joinedAtMs <= atMs - REPORT_DAY_MS/u);
  const targetChecks = source('apps/api/src/moderation/reports/report-state.service.ts');
  assert.match(targetChecks, /member\.isAdmin \|\|\s*member\.isOwner/u);
});

test('member subscription help and night permissions stay separate from setup procedures', () => {
  for (const id of ['subscription', 'subscription-membership', 'subscription-participant']) {
    assert.match(fact(id), /Обязательная подписка — участие аккаунта.*чатах и каналах MAX/u, id);
    assert.match(fact(id), /проверяет членство.*не означает оплату услуг бота/u, id);
  }
  const membership = fact('subscription-membership');
  assert.match(membership, /всем источникам.*сообщении бота/u);
  assert.match(membership, /уже подписаны.*администраторам именно этого чата/u);
  assert.match(membership, /не видит ваш аккаунт.*не может подтвердить личную подписку/u);
  assert.doesNotMatch(membership, /Добавить источник|Добавить по ссылке|настройки.*Подписка/u);
  const participant = fact('subscription-participant');
  assert.match(participant, /сам открывает ссылки.*подписывается на все указанные/u);
  assert.match(participant, /не подписывает участника автоматически/u);
  assert.doesNotMatch(participant, /Добавить источник|Добавить по ссылке/u);
  assert.equal(entries.get('subscription-participant').delivery, undefined);

  const night = fact('night');
  assert.match(
    night,
    /включите «Закрывать по расписанию».*Закрывать с.*Открывать в.*Часовой пояс/u,
  );
  assert.doesNotMatch(night, /Закрыть вручную|тишина/u);
  const permissions = fact('night-permissions');
  assert.match(permissions, /администраторы могут продолжать писать/u);
  assert.match(permissions, /не подтверждает.*конкретный пост администратора/u);
  assert.doesNotMatch(permissions, /выключите|Закрывать с|Открывать в/u);

  const nightUi = source('apps/miniapp/src/pages/settings/settings-night-section.tsx');
  assert.match(nightUi, /Администраторы могут продолжать писать/u);
  assert.match(nightUi, /Администраторы смогут продолжать писать/u);
  const manual = fact('night-manual');
  for (const label of ['Закрыть сейчас', 'Закрыть вручную', 'Без срока']) {
    assert.ok(nightUi.includes(label), label);
    assert.ok(manual.includes(label), label);
  }
  assert.match(manual, /ночное расписание продолжает действовать/u);
});

test('reviewed delivery is restricted to three bounded answers with preserved evidence', () => {
  const reviewedIds = [...entries.values()]
    .filter((entry) => entry.delivery === 'reviewed')
    .map((entry) => entry.id)
    .sort();
  assert.deepEqual(reviewedIds, [
    'max-public-channel-eligibility',
    'subscription-membership',
    'support-incident-evidence',
  ]);
  const eligibility = fact('max-public-channel-eligibility');
  for (const required of [/все три условия/u, /российский номер/u, /Цифровой ID/u, /менее пяти/u])
    assert.match(eligibility, required);
  assert.match(eligibility, /через платформу.*для бизнеса.*А\+/u);
  assert.match(eligibility, /уже пять.*этим способом нельзя/u);
  assert.doesNotMatch(eligibility, /удалите|удалить|смените|другой аккаунт/u);
  const evidence = fact('support-incident-evidence');
  assert.match(evidence, /название вашего сообщества, время проблемы и пример/u);
  assert.match(evidence, /События.*недоступен.*этими данными/u);
  assert.match(evidence, /сам не просматривает журналы и аккаунт/u);
  assert.match(evidence, /Токены, пароли, коды входа.*не нужны/u);
  assert.doesNotMatch(fact('subscription-membership'), /откройте ссылки|подпишитесь|Добавить/u);
});

test('disabling link deletion selects the actual allow-all mode and saves it', () => {
  const links = fact('links-policy');
  assert.match(links, /отключить.*«Ссылки» → «Режим».*«Разрешать все».*«Сохранить»/u);
  const ui = source('apps/miniapp/src/pages/settings/shared-chat-settings-fields.tsx');
  for (const label of ['Разрешать все', 'Удалять все', 'Разрешать по списку']) {
    assert.ok(ui.includes(`label: '${label}'`), label);
    assert.ok(links.includes(`«${label}»`), label);
  }
  assert.match(ui, /value: 'ALERT_ONLY' as const, label: 'Разрешать все'/u);
  assert.match(ui, /value: 'BLOCKLIST_ONLY' as const, label: 'Удалять все'/u);
  assert.match(links, /«Удалять все» включает запрет ссылок и не подходит для отключения/u);
  const detector = source('apps/api/src/moderation/rule-engine-link-detector.ts');
  assert.match(detector, /policy === LinkPolicy\.ALERT_ONLY\) \{\s*return null;/u);
  assert.match(
    source('apps/miniapp/src/pages/settings/settings-section-save-footer.tsx'),
    /options\?\.saveLabel \?\? 'Сохранить'/u,
  );
});
