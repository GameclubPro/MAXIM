import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const scenarios = [
  'setup',
  'draft',
  'draft_empty',
  'paused',
  'preview_missing',
  'public_view',
  'switch_chat',
  'bridge_error',
  'active',
  'error',
  'unknown',
  'existing',
  'existing_unknown',
  'existing_rules_changed',
  'existing_options_error',
  'recovery',
  'recovery_conflict',
  'recovery_conflict_unknown',
  'recovery_conflict_superseded',
  'recovery_restored_superseded',
  'recovery_restored_current',
  'recovery_restored_unavailable',
  'recovery_restored_cached',
  'recovery_restored_actor_switch',
  'access_changed',
  'disconnect',
  'reviewer',
  'partial',
  'partial_bound',
  'server_restore',
  'choice',
];
const selectedScenarios = process.env.KARAVAN_BROWSER_SCENARIOS?.split(',') ?? scenarios;
assert.ok(
  selectedScenarios.length > 0 && selectedScenarios.every((item) => scenarios.includes(item)),
  'Unknown Karavan browser scenario',
);
const root = resolve(import.meta.dirname, '..');
const fixtures = resolve(root, 'build/karavan-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/karavan-test-`);
const output = await mkdtemp('/tmp/maxim-karavan-browser-');
const base = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const path = `${base}build/karavan-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="test-root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  `${fixture}/fixture.tsx`,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import '../../../src/styles.css';
import '../../../src/pages/settings-page';
import '../../../src/styles/moderation-workspace.css';
import Panel from '../../../src/pages/settings/karavan-marketplace-panel';
import {ApiRequestError} from '../../../src/lib/api-request-error';
import {StorefrontWorkspace} from '../../../src/pages/settings/storefront-workspace';
const scenario = new URLSearchParams(location.search).get('scenario');
document.documentElement.dataset.maxTheme = new URLSearchParams(location.search).get('theme') || 'light';
document.body.dataset.miniappProfile = 'moderation';
Object.assign(document.body.style,{margin:'0',padding:'20px 16px',background:'var(--color-surface)',fontFamily:'var(--font-body)'});
const uuid='a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const marketplace={id:uuid,networkId:'c41eba17-407e-4e51-b23c-1dd3edca4e63',publicSlug:'synthetic-shop',name:'Магазин соседей — длинное название для проверки переноса',description:null,kind:'chat',status:scenario==='paused'?'paused':['active','existing','existing_unknown','existing_rules_changed','existing_options_error','choice','public_view','switch_chat','bridge_error'].includes(scenario)?'active':'draft',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1};
const binding={id:'9c9e1a8e-533f-49f8-9d5e-2bbad494bb74',chatId:'-123',chatTitle:'Соседи',state:scenario==='recovery'?'revoked':'verified',generation:1,revision:1,verifiedAt:new Date().toISOString()};
let connected=['active','draft','draft_empty','paused','preview_missing','public_view','switch_chat','bridge_error','recovery','recovery_conflict','recovery_conflict_unknown','recovery_restored_superseded','recovery_restored_current','access_changed','disconnect','reviewer','choice'].includes(scenario); let reads=0; let setups=Number(sessionStorage.getItem('setups')||0); let operation=JSON.parse(sessionStorage.getItem('operation')||'null'); let chosen=false; let optionReads=0; let previewReads=0; let recovered=false;
let moduleActor='777';
if(scenario.startsWith('recovery_restored_')) {
  connected=true; marketplace.status='active'; binding.generation=['recovery_restored_current','recovery_restored_actor_switch'].includes(scenario)?1:2;
  if(!sessionStorage.getItem('restored-seeded')) {
    localStorage.setItem('karavan-binding:v1:777:-123',JSON.stringify({marketplaceId:uuid,commandId:'b0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedBindingGeneration:1,action:'recover_chat'}));
    sessionStorage.setItem('restored-seeded','yes');
    if(scenario==='recovery_restored_actor_switch') localStorage.setItem('karavan-binding:v1:888:-123',JSON.stringify({marketplaceId:uuid,commandId:'c0d9b7ce-0040-4c85-a7ec-e3cf6da94c10',expectedBindingGeneration:2,action:'recover_chat'}));
  }
}
if(scenario==='recovery_conflict_superseded') connected=true;
if(scenario==='server_restore') { const request={operationId:uuid,chatIds:['-123','-456'],create:{name:'Сохранённый магазин',rules:{text:'Rules',allowedCategoryIds:['services'],allowedSubcategoryIds:[]}}}; operation={operationId:uuid,state:'partial',request,checkpoints:{marketplaceId:uuid,bindings:request.chatIds.map(chatId=>({chatId,state:'failed',bindingId:null,generation:null}))}}; }
window.__karavanRequests=[]; window.__karavanOpened=[]; window.__karavanClosed=0; window.WebApp={openMaxLink:(url)=>{if(scenario==='bridge_error'&&!window.__bridgeRetry) throw new Error('Bridge unavailable');window.__karavanOpened.push(url)},close:()=>{window.__karavanClosed++}};
const api={request:async(path,init={})=>{
  window.__karavanRequests.push({path,body:init.body?JSON.parse(init.body):null});
  if(path.endsWith('/handoffs')) { const input=JSON.parse(init.body); const result={url:['view','preview'].includes(input.destination)?'https://max.ru/synthetic_buyer_bot?startapp=mh_'+('x'.repeat(43)):'https://max.ru/synthetic_seller_bot?startapp=community_h_'+('x'.repeat(43)),expiresAt:new Date(Date.now()+120000).toISOString()}; if(scenario==='switch_chat') return new Promise(resolve=>{window.__resolveKaravanHandoff=()=>resolve(result)}); return result; }
  if(path==='/chats') return [{id:'-123',title:'Соседи',createdAt:new Date().toISOString()},{id:'-456',title:'Ещё один очень длинный заголовок чата наших соседей',createdAt:new Date().toISOString()}];
  if(path.endsWith('/setup-options')&&scenario==='existing_options_error'&&optionReads++===0) throw new Error('Категории недоступны');
  if(path.endsWith('/setup-options')) return {chatTitle:'Соседи',categories:[{id:'services',label:'Услуги',subcategories:[{id:'services.repair',label:'Ремонт'},{id:'services.cleaning',label:'Уборка'}]},{id:'grocery',label:'Продукты',subcategories:[{id:'grocery.fruit',label:'Фрукты'}]}]};
  if(path.endsWith('/preview')) { const input=JSON.parse(init.body); previewReads++; const changed=scenario==='existing_rules_changed'&&previewReads>1; return {target:input.marketplaceId?{marketplace:{...marketplace,policyRevision:changed?2:1},rules:{text:changed?'Обновлённые правила существующего магазина':'Проверенные правила существующего магазина',allowedCategoryIds:['services'],allowedSubcategoryIds:['services.repair'],categoryOrder:['services'],version:changed?2:1},permissions:['bind_chat','manage_network'],counts:{listings:12,pendingApplications:0,chats:2},bindings:[binding]}:null,chats:input.chatIds.map(chatId=>({chatId,title:chatId==='-123'?'Соседи':'Второй чат',binding:null,marketplace:null}))}; }
  if(path.endsWith('/publication-choice')) {chosen=true;return {saved:true,storeId:JSON.parse(init.body).storeId};}
  if(path.endsWith('/available')) return {marketplaces:[{marketplace,permissions:['manage_network','bind_chat']}],nextCursor:null};
  if(path.includes('/bindings/')) {
    if(scenario==='existing_unknown'&&!sessionStorage.getItem('bind-attempted')) {sessionStorage.setItem('bind-attempted','yes'); throw new Error('Ответ потерян');}
    if(['recovery_conflict_unknown','recovery_conflict_superseded'].includes(scenario)&&!sessionStorage.getItem('bind-attempted')) {sessionStorage.setItem('bind-attempted','yes');throw new Error('Ответ потерян');}
    if(scenario.startsWith('recovery_conflict')) {recovered=true;binding.generation=scenario==='recovery_conflict_unknown'?1:2;marketplace.status='active';throw new ApiRequestError(409,JSON.stringify({code:'MARKETPLACE_BINDING_CHANGED'}),'Подключение изменилось');}
    const input=JSON.parse(init.body); recovered=input.action==='recover_chat'; connected=true; marketplace.status=input.action==='unbind_chat'?'paused':'active'; binding.state=input.action==='unbind_chat'?'disconnected':'verified';
    return {marketplace,bindingId:binding.id,generation:1};
  }
  if(path.endsWith('/setup')) {
    const input=JSON.parse(init.body); setups++;sessionStorage.setItem('setups',String(setups));
    operation={operationId:input.operationId,state:setups===1?'pending':'complete',request:input,checkpoints:{marketplaceId:uuid,bindings:input.chatIds.map(chatId=>({chatId,state:setups===1?'pending':'connected',bindingId:binding.id,generation:1}))}};
    if(['partial','partial_bound'].includes(scenario)) { operation.state='partial'; connected=scenario==='partial_bound'; operation.checkpoints.bindings.forEach(item=>item.state=connected&&item.chatId==='-123'?'connected':'failed'); return operation; }
    sessionStorage.setItem('operation',JSON.stringify(operation));
    if(['unknown','existing_unknown'].includes(scenario)&&setups===1) throw new Error('Сеть недоступна');
    if(setups>1) connected=true;
    return operation;
  }
  if(path.includes('/operations/')&&path.endsWith('/cancel')) {operation.state='cancelled';sessionStorage.setItem('operation',JSON.stringify(operation));return operation;}
  if(path.includes('/operations/')) return operation;
  if(scenario==='error' && reads++===0) throw new Error('Сеть недоступна');
  if(scenario==='loading') await new Promise(resolve=>setTimeout(resolve,800));
  if(scenario==='recovery_restored_unavailable'&&!sessionStorage.getItem('restored-allow-read')) throw new Error('Проверка временно недоступна');
  return {enabled:true,actorMaxUserId:moduleActor,sellerBotUrl:'https://max.ru/synthetic_seller_bot',setupOperation:scenario==='server_restore'?operation:null,currentChatTitle:'Соседи',buyerUrl:connected?'https://max.ru/synthetic_buyer_bot?startapp=m_'+(path.includes('/-456/')?'other-shop':'synthetic-shop'):null,previewUrl:connected&&scenario!=='preview_missing'&&['draft','paused'].includes(marketplace.status)?'https://max.ru/synthetic_buyer_bot?startapp=mp_synthetic-shop':null,bindings:connected?[binding]:[],publicationChoices:scenario==='choice'&&!chosen?[{id:uuid,marketplaceId:uuid,marketplaceName:marketplace.name,chatId:'-123',expiresAt:new Date(Date.now()+900000).toISOString(),stores:[{id:uuid,name:'Первая витрина'},{id:'bb669048-0279-4a35-987c-60f94593163e',name:'Вторая витрина'}]}]:[],marketplace:connected?(path.includes('/-456/')?{...marketplace,name:'Другой магазин'}:marketplace):null,binding:connected?binding:null,access:{reason:!recovered&&(scenario==='access_changed'||scenario==='recovery'||scenario.startsWith('recovery_conflict'))?'binding_changed':scenario==='public_view'?'forbidden':'allowed',canRecover:!recovered&&(scenario==='recovery'||scenario==='access_changed'||scenario.startsWith('recovery_conflict'))},permissions:scenario==='public_view'||(!recovered&&scenario==='access_changed')?[]:scenario==='reviewer'?['review_listing']:['manage_network','bind_chat','manage_marketplace','review_listing'],counts:{listings:connected&&scenario!=='draft_empty'?12:0,pendingApplications:connected&&scenario!=='draft_empty'?3:0,chats:connected?2:0},canManage:scenario!=='reviewer'};
},requestKeepalive:()=>{}};
function Harness(){const [chatId,setChatId]=React.useState('-123');window.__switchKaravanChat=()=>setChatId('-456');return <StorefrontWorkspace key={chatId} open onClose={()=>{}}><Panel api={api} chatId={chatId}/></StorefrontWorkspace>;}
const queryClient=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
window.__switchKaravanActor=()=>{moduleActor='888';binding.generation=2;return queryClient.invalidateQueries({queryKey:['karavan-marketplace','-123']});};
if(scenario==='recovery_restored_cached') {
  const snapshot=await api.request('/chats/-123/karavan-marketplace');
  queryClient.setQueryData(['karavan-marketplace','-123'],{...snapshot,binding:{...binding,generation:1}});
}
createRoot(document.getElementById('test-root')).render(<QueryClientProvider client={queryClient}><Harness/></QueryClientProvider>);
`,
);
let server;
let browser;
async function geometry(page, name) {
  const bounds = await page.evaluate(() => ({
    primaryColors: [...document.querySelectorAll('.karavan-module__primary')].map(
      (el) => getComputedStyle(el).color,
    ),
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    controls: [
      ...document.querySelectorAll(
        '.karavan-module button,.karavan-module input:not([type=checkbox]):not([type=radio]),.karavan-module summary',
      ),
    ].map((el) => ({
      text: el.textContent?.trim(),
      ...Object.fromEntries(
        ['width', 'height', 'left', 'right'].map((key) => [key, el.getBoundingClientRect()[key]]),
      ),
    })),
  }));
  for (const color of bounds.primaryColors)
    assert.equal(color, 'rgb(255, 255, 255)', `${name}: primary contrast`);
  assert.ok(bounds.scroll <= bounds.width + 1, `${name}: horizontal overflow`);
  for (const control of bounds.controls)
    if (control.width > 0) {
      assert.ok(control.height >= 43.5, `${name}: small control ${control.text}`);
      assert.ok(
        control.left >= -1 && control.right <= bounds.width + 1,
        `${name}: clipped control ${control.text} (${control.left}..${control.right} / ${bounds.width})`,
      );
    }
}
try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch();
  for (const width of process.env.KARAVAN_BROWSER_WIDTH
    ? [Number(process.env.KARAVAN_BROWSER_WIDTH)]
    : [320, 360, 390, 430])
    for (const theme of process.env.KARAVAN_BROWSER_THEME
      ? [process.env.KARAVAN_BROWSER_THEME]
      : ['light', 'dark']) {
      for (const scenario of selectedScenarios) {
        const context = await browser.newContext({
          viewport: { width, height: 740 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        let page;
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(path + '?scenario=' + scenario + '&theme=' + theme);
          if (scenario === 'server_restore') {
            await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
            assert.equal(await page.getByRole('button', { name: 'Настроить черновик' }).count(), 0);
            assert.equal(
              await page.getByRole('button', { name: 'Создать магазин', exact: true }).count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
          }
          if (scenario === 'error') {
            await page.getByText('Не удалось проверить магазин.').waitFor();
            await page.getByRole('button', { name: 'Повторить', exact: true }).click();
          }
          if (['setup', 'unknown', 'partial', 'partial_bound'].includes(scenario)) {
            await page.getByRole('button', { name: 'Подключить магазин', exact: true }).click();
            await page.getByRole('button', { name: /Добавить мои чаты/u }).click();
            await page.getByLabel('Ещё один очень длинный заголовок чата наших соседей').check();
            await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            assert.equal(
              await page.getByLabel('Название магазина', { exact: true }).inputValue(),
              'Соседи',
            );
            await page
              .getByLabel('Название магазина', { exact: true })
              .fill('Общий магазин соседей и друзей нашего большого района');
            await page.getByRole('checkbox', { name: 'Продукты', exact: true }).uncheck();
            await page.getByText('Направления · 2 из 2', { exact: true }).click();
            await page.getByRole('checkbox', { name: 'Уборка', exact: true }).uncheck();
            await geometry(page, `${width}-${theme}-rules`);
            await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await geometry(page, `${width}-${theme}-confirm`);
            await page.screenshot({
              path: output + '/' + width + '-' + theme + '-' + scenario + '-confirm.png',
              fullPage: true,
            });
            await page.getByRole('button', { name: 'Создать черновик', exact: true }).click();
            if (scenario === 'unknown')
              await page.getByRole('button', { name: 'Продолжить подключение' }).click();
            if (['partial', 'partial_bound'].includes(scenario)) {
              if (scenario === 'partial_bound') {
                await page.getByRole('button', { name: 'Настроить черновик' }).click();
                const panel = page.getByRole('dialog', { name: 'Интернет-витрина', exact: true });
                await panel.getByRole('button', { name: 'Каталог', exact: true }).waitFor();
                assert.equal(await page.evaluate(() => window.__karavanOpened.length), 0);
                await panel.getByRole('button', { name: 'Назад к магазину' }).waitFor();
                await page.keyboard.press('Escape');
              } else {
                assert.equal(
                  await page.getByRole('button', { name: 'Настроить черновик' }).count(),
                  0,
                );
              }
              await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
              page.once('dialog', (dialog) => dialog.accept());
              await page
                .getByRole('button', { name: 'Остановить оставшиеся подключения', exact: true })
                .click();
              await page
                .getByText(
                  'Подключение остановлено. Созданный магазин и уже подключённые чаты сохранены.',
                  { exact: true },
                )
                .waitFor();
            } else
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^Черновик/u })
                .waitFor();
            const requests = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.endsWith('/setup')),
            );
            assert.ok(requests.length >= (['partial', 'partial_bound'].includes(scenario) ? 1 : 2));
            assert.equal(new Set(requests.map((item) => item.body.operationId)).size, 1);
            assert.deepEqual(requests[0].body.chatIds, ['-123', '-456']);
            assert.deepEqual(requests[0].body.create.rules.allowedSubcategoryIds, [
              'services.repair',
            ]);
            assert.equal(requests[0].body.bindingExpectations.length, 2);
          }
          if (
            [
              'existing',
              'existing_unknown',
              'existing_rules_changed',
              'existing_options_error',
            ].includes(scenario)
          ) {
            await page.getByRole('button', { name: 'Подключить магазин', exact: true }).click();
            await page.getByRole('radio', { name: 'Выбрать существующий', exact: true }).check();
            await page.getByRole('radio', { name: marketplaceName(), exact: true }).check();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
              ),
              0,
            );
            await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            await page
              .getByText('Проверенные правила существующего магазина', { exact: true })
              .waitFor();
            if (scenario === 'existing_options_error') {
              assert.equal(await page.getByText('services', { exact: true }).count(), 0);
              await page.getByText('Услуги', { exact: true }).waitFor();
              await page.getByRole('button', { name: 'Повторить загрузку категорий' }).click();
              await page.waitForFunction(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/setup-options'))
                    .length === 2,
              );
              await page.getByRole('button', { name: 'Продолжить', exact: true }).waitFor();
            }
            await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            if (scenario === 'existing_rules_changed') {
              await page
                .getByText('Правила изменились. Проверьте их ещё раз.', { exact: true })
                .waitFor();
              await page
                .getByText('Обновлённые правила существующего магазина', { exact: true })
                .waitFor();
              assert.equal(
                await page
                  .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
                  .count(),
                0,
              );
              assert.equal(
                await page.evaluate(
                  () =>
                    window.__karavanRequests.filter((item) => item.path.endsWith('/setup')).length,
                ),
                0,
              );
              await geometry(page, `${width}-${theme}-updated-rules`);
              await page.screenshot({
                path: output + '/' + width + '-' + theme + '-updated-rules.png',
                fullPage: true,
              });
              await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
            }
            await page
              .getByRole('checkbox', { name: 'Подтверждаю выбранные чаты и правила магазина' })
              .check();
            await page.getByRole('button', { name: 'Подключить', exact: true }).click();
            if (scenario === 'existing_unknown') {
              await page.getByRole('button', { name: 'Продолжить подключение' }).waitFor();
              const initial = await page.evaluate(
                () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
              );
              await page.reload();
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^Открыт/u })
                .waitFor();
              const retried = await page.evaluate(
                () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
              );
              assert.deepEqual(retried, initial, 'reload must preserve immutable existing setup');
            } else
              await page
                .locator('.karavan-module__identity p')
                .filter({ hasText: /^Открыт/u })
                .waitFor();
            const request = await page.evaluate(
              () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
            );
            assert.equal(request.create, undefined);
            assert.equal(
              request.expectedPolicyRevision,
              scenario === 'existing_rules_changed' ? 2 : 1,
            );
          }
          if (scenario === 'choice') {
            await page.getByRole('button', { name: 'Вторая витрина', exact: true }).click();
            await page
              .getByText(
                'Выбор сохранён. Повторите $ в чате, когда захотите опубликовать ссылку.',
                { exact: true },
              )
              .waitFor();
            const writes = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.body),
            );
            assert.equal(writes.length, 1);
            assert.ok(writes[0].path.endsWith('/publication-choice'));
          }
          if (['recovery', 'access_changed', 'recovery_conflict'].includes(scenario)) {
            await page.getByRole('button', { name: 'Восстановить подключение' }).click();
            await page
              .locator('.karavan-module__identity p')
              .filter({ hasText: /^Открыт/u })
              .waitFor();
            const body = await page.evaluate(
              () => window.__karavanRequests.find((item) => item.path.includes('/bindings/')).body,
            );
            assert.equal(body.action, 'recover_chat');
            assert.equal(body.expectedBindingGeneration, 1);
          }
          if (scenario === 'recovery_conflict') {
            assert.equal(
              await page.getByRole('button', { name: 'Восстановить подключение' }).count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.includes('/bindings/'))
                    .length,
              ),
              1,
              'A conflict refresh must not replay recovery',
            );
            assert.equal(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              null,
            );
          }
          if (['recovery_conflict_unknown', 'recovery_conflict_superseded'].includes(scenario)) {
            await page.getByRole('button', { name: 'Восстановить подключение' }).click();
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            await page.getByRole('button', { name: 'Повторить проверку', exact: true }).click();
            if (scenario === 'recovery_conflict_unknown') {
              await page.getByText('Подключение изменилось', { exact: true }).waitFor();
              assert.equal(
                await page.getByRole('button', { name: 'Обновить состояние', exact: true }).count(),
                0,
                'An earlier unknown result at the same generation remains fenced',
              );
              assert.ok(
                await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              );
            } else {
              await page.getByRole('button', { name: 'Посмотреть магазин', exact: true }).waitFor();
              assert.equal(
                await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
                null,
              );
            }
            const writes = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.includes('/bindings/')),
            );
            assert.equal(writes.length, 2);
            assert.equal(writes[0].body.commandId, writes[1].body.commandId);
          }
          if (scenario === 'recovery_restored_unavailable') {
            await page
              .getByRole('alert')
              .filter({ hasText: 'Не удалось проверить магазин.' })
              .waitFor();
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            );
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
            );
            await page.evaluate(() => {
              sessionStorage.setItem('restored-allow-read', 'yes');
            });
            await page.getByRole('button', { name: 'Повторить', exact: true }).click();
          }
          if (
            [
              'recovery_restored_superseded',
              'recovery_restored_cached',
              'recovery_restored_unavailable',
            ].includes(scenario)
          ) {
            await page.getByRole('button', { name: 'Посмотреть магазин', exact: true }).waitFor();
            assert.equal(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              null,
            );
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
              'Restored obsolete request must not send a mutation',
            );
            await page.reload();
            await page.getByRole('button', { name: 'Посмотреть магазин', exact: true }).waitFor();
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
            );
          }
          if (scenario === 'recovery_restored_current') {
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
            );
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
              'A current uncertain request must not be replayed or discarded',
            );
          }
          if (scenario === 'recovery_restored_actor_switch') {
            await page.getByText('Результат изменения ещё не подтверждён.').waitFor();
            await page.evaluate(() => window.__switchKaravanActor());
            await page.evaluate(
              () =>
                new Promise((resolve) =>
                  requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
            );
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:777:-123')),
              'Keep the previous actor request',
            );
            assert.ok(
              await page.evaluate(() => localStorage.getItem('karavan-binding:v1:888:-123')),
              'Never clear the next actor request using a previous actor state',
            );
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
            );
          }
          if (scenario === 'disconnect') {
            await page.getByRole('button', { name: 'Чаты', exact: true }).click();
            await page.getByRole('button', { name: 'Отключить этот чат' }).click();
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.includes('/bindings/'))
                    .length,
              ),
              0,
            );
            await page.getByRole('button', { name: 'Подтвердить отключение' }).click();
            await page.getByText('Чат отключён от магазина.').waitFor();
          }
          if (scenario === 'reviewer') {
            await page.getByRole('button', { name: 'Заявки', exact: true }).waitFor();
            assert.equal(
              await page.getByRole('button', { name: 'Категории и правила', exact: true }).count(),
              0,
            );
          }
          await page.locator('.karavan-module h3:visible').waitFor();
          await geometry(page, `${width}-${theme}-${scenario}`);
          if (['active', 'public_view', 'bridge_error'].includes(scenario)) {
            await page.getByRole('button', { name: 'Посмотреть магазин', exact: true }).click();
            if (scenario === 'bridge_error') {
              await page
                .getByRole('alert')
                .filter({ hasText: 'Не удалось открыть магазин' })
                .waitFor();
              assert.equal(await page.evaluate(() => window.__karavanClosed), 0);
              await page.evaluate(() => {
                window.__bridgeRetry = true;
              });
              await page.getByRole('button', { name: 'Повторить переход', exact: true }).click();
            }
            await page.waitForFunction(() => window.__karavanOpened.length === 1);
            assert.equal(
              await page.evaluate(() => window.__karavanOpened[0]),
              'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop',
            );
            assert.equal(
              await page.evaluate(
                () =>
                  window.__karavanRequests.filter((item) => item.path.endsWith('/handoffs')).length,
              ),
              0,
            );
            assert.equal(
              await page.getByRole('button', { name: 'Повторить переход', exact: true }).count(),
              0,
            );
            const beforeReturn = await page.evaluate(() => window.__karavanRequests.length);
            await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
            await page.waitForFunction(
              (before) => window.__karavanRequests.length > before,
              beforeReturn,
            );
          }
          if (['draft', 'draft_empty', 'paused', 'preview_missing'].includes(scenario)) {
            assert.equal(
              await page
                .getByRole('button', { name: /^(Посмотреть магазин|Предпросмотр)$/u })
                .count(),
              0,
            );
            assert.equal(
              await page.evaluate(
                () => window.__karavanRequests.filter((item) => item.body).length,
              ),
              0,
              'reading a closed shop must neither activate it nor create a private preview',
            );
          }
          if (scenario === 'switch_chat') {
            await page.evaluate(() => window.__switchKaravanChat());
            await page.getByRole('heading', { name: 'Другой магазин' }).waitFor();
            await page.getByRole('button', { name: 'Посмотреть магазин', exact: true }).click();
            assert.deepEqual(await page.evaluate(() => window.__karavanOpened), [
              'https://max.ru/synthetic_buyer_bot?startapp=m_other-shop',
            ]);
          }
          assert.equal(
            await page.locator('.karavan-module__metrics,.karavan-module__eyebrow').count(),
            0,
          );
          assert.equal(
            await page.evaluate(() => window.__karavanClosed),
            0,
            'storefront navigation must not close Major',
          );
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: output + '/' + width + '-' + theme + '-' + scenario + '.png',
            fullPage: true,
          });
        } catch (error) {
          console.error(
            `${width}/${theme}/${scenario}: ${page ? (await page.locator('body').innerText()).slice(-2500) : 'Page unavailable'}`,
          );
          throw error;
        } finally {
          await context.close();
        }
      }
    }
  console.log(
    'Karavan browser: ' +
      selectedScenarios.length *
        (process.env.KARAVAN_BROWSER_WIDTH ? 1 : 4) *
        (process.env.KARAVAN_BROWSER_THEME ? 1 : 2) +
      ' scenarios passed. Screenshots: ' +
      output,
  );
} finally {
  await browser?.close();
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
function marketplaceName() {
  return 'Магазин соседей — длинное название для проверки переноса';
}
