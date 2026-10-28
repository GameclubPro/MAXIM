import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

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
import Panel from '../../../src/pages/settings/karavan-marketplace-panel';
const scenario = new URLSearchParams(location.search).get('scenario');
document.documentElement.dataset.maxTheme = new URLSearchParams(location.search).get('theme') || 'light';
document.body.dataset.miniappProfile = 'moderation';
Object.assign(document.body.style,{margin:'0',padding:'20px 16px',background:'var(--color-surface)',fontFamily:'var(--font-body)'});
const uuid='a0d9b7ce-0040-4c85-a7ec-e3cf6da94c10';
const marketplace={id:uuid,networkId:'c41eba17-407e-4e51-b23c-1dd3edca4e63',publicSlug:'synthetic-shop',name:'Магазин соседей — длинное название для проверки переноса',description:null,kind:'chat',status:['active','existing','existing_unknown','choice'].includes(scenario)?'active':'draft',admissionPolicy:'applications',logoImageUrl:null,coverImageUrl:null,editRevision:1,policyRevision:1,orderRevision:1,visibilityRevision:1};
const binding={id:'9c9e1a8e-533f-49f8-9d5e-2bbad494bb74',chatId:'-123',chatTitle:'Соседи',state:scenario==='recovery'?'revoked':'verified',generation:1,revision:1,verifiedAt:new Date().toISOString()};
let connected=['active','draft','recovery','disconnect','reviewer','choice'].includes(scenario); let reads=0; let setups=Number(sessionStorage.getItem('setups')||0); let operation=JSON.parse(sessionStorage.getItem('operation')||'null'); let chosen=false;
if(scenario==='server_restore') { const request={operationId:uuid,chatIds:['-123','-456'],create:{name:'Сохранённый магазин',rules:{text:'Rules',allowedCategoryIds:['services'],allowedSubcategoryIds:[]}}}; operation={operationId:uuid,state:'partial',request,checkpoints:{marketplaceId:uuid,bindings:request.chatIds.map(chatId=>({chatId,state:'failed',bindingId:null,generation:null}))}}; }
window.__karavanRequests=[];
const api={request:async(path,init={})=>{
  window.__karavanRequests.push({path,body:init.body?JSON.parse(init.body):null});
  if(path==='/chats') return [{id:'-123',title:'Соседи',createdAt:new Date().toISOString()},{id:'-456',title:'Ещё один очень длинный заголовок чата наших соседей',createdAt:new Date().toISOString()}];
  if(path.endsWith('/setup-options')) return {chatTitle:'Соседи',categories:[{id:'services',label:'Услуги',subcategories:[{id:'services.repair',label:'Ремонт'},{id:'services.cleaning',label:'Уборка'}]},{id:'grocery',label:'Продукты',subcategories:[{id:'grocery.fruit',label:'Фрукты'}]}]};
  if(path.endsWith('/preview')) { const input=JSON.parse(init.body); return {target:input.marketplaceId?{marketplace,rules:{text:'Проверенные правила существующего магазина',allowedCategoryIds:['services'],allowedSubcategoryIds:['services.repair'],categoryOrder:['services'],version:1},permissions:['bind_chat','manage_network'],counts:{listings:12,pendingApplications:0,chats:2},bindings:[binding]}:null,chats:input.chatIds.map(chatId=>({chatId,title:chatId==='-123'?'Соседи':'Второй чат',binding:null,marketplace:null}))}; }
  if(path.endsWith('/publication-choice')) {chosen=true;return {saved:true,storeId:JSON.parse(init.body).storeId};}
  if(path.endsWith('/available')) return {marketplaces:[{marketplace,permissions:['manage_network','bind_chat']}],nextCursor:null};
  if(path.includes('/bindings/')) {
    if(scenario==='existing_unknown'&&!sessionStorage.getItem('bind-attempted')) {sessionStorage.setItem('bind-attempted','yes'); throw new Error('Ответ потерян');}
    const input=JSON.parse(init.body); connected=true; marketplace.status=input.action==='unbind_chat'?'paused':'active'; binding.state=input.action==='unbind_chat'?'disconnected':'verified';
    return {marketplace,bindingId:binding.id,generation:1};
  }
  if(path.endsWith('/setup')) {
    const input=JSON.parse(init.body); setups++;sessionStorage.setItem('setups',String(setups));
    operation={operationId:input.operationId,state:setups===1?'pending':'complete',request:input,checkpoints:{marketplaceId:uuid,bindings:input.chatIds.map(chatId=>({chatId,state:setups===1?'pending':'connected',bindingId:binding.id,generation:1}))}};
    if(scenario==='partial') { operation.state='partial'; operation.checkpoints.bindings.forEach(item=>item.state='failed'); return operation; }
    sessionStorage.setItem('operation',JSON.stringify(operation));
    if(['unknown','existing_unknown'].includes(scenario)&&setups===1) throw new Error('Сеть недоступна');
    if(setups>1) connected=true;
    return operation;
  }
  if(path.includes('/operations/')&&path.endsWith('/cancel')) {operation.state='cancelled';sessionStorage.setItem('operation',JSON.stringify(operation));return operation;}
  if(path.includes('/operations/')) return operation;
  if(scenario==='error' && reads++===0) throw new Error('Сеть недоступна');
  if(scenario==='loading') await new Promise(resolve=>setTimeout(resolve,800));
  return {enabled:true,actorMaxUserId:'777',sellerBotUrl:'https://max.ru/synthetic_seller_bot',setupOperation:scenario==='server_restore'?operation:null,currentChatTitle:'Соседи',buyerUrl:connected?'https://max.ru/synthetic_buyer_bot?startapp=m_synthetic-shop':null,bindings:connected?[binding]:[],publicationChoices:scenario==='choice'&&!chosen?[{id:uuid,marketplaceId:uuid,marketplaceName:marketplace.name,chatId:'-123',expiresAt:new Date(Date.now()+900000).toISOString(),stores:[{id:uuid,name:'Первая витрина'},{id:'bb669048-0279-4a35-987c-60f94593163e',name:'Вторая витрина'}]}]:[],marketplace:connected?marketplace:null,binding:connected?binding:null,permissions:scenario==='reviewer'?['review_listing']:['manage_network','bind_chat','manage_marketplace','review_listing'],counts:{listings:connected?12:0,pendingApplications:connected?3:0,chats:connected?2:0},canManage:scenario!=='reviewer'};
},requestKeepalive:()=>{}};
createRoot(document.getElementById('test-root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><Panel api={api} chatId="-123"/></QueryClientProvider>);
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
        `${name}: clipped control ${control.text}`,
      );
    }
}
try {
  server = await ensureMiniappDevServer(base);
  browser = await chromium.launch();
  for (const width of [320, 390])
    for (const theme of ['light', 'dark']) {
      for (const scenario of [
        'setup',
        'draft',
        'active',
        'error',
        'unknown',
        'existing',
        'existing_unknown',
        'recovery',
        'disconnect',
        'reviewer',
        'partial',
        'server_restore',
        'choice',
      ]) {
        const context = await browser.newContext({
          viewport: { width, height: 740 },
          isMobile: true,
          hasTouch: true,
          colorScheme: theme,
          reducedMotion: 'reduce',
        });
        try {
          await context.route('**/*', (route) =>
            new URL(route.request().url()).origin === new URL(base).origin
              ? route.continue()
              : route.abort(),
          );
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(path + '?scenario=' + scenario + '&theme=' + theme);
          if (scenario === 'server_restore') {
            await page.getByRole('button', { name: 'Настроить черновик' }).waitFor();
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
          if (['setup', 'unknown', 'partial'].includes(scenario)) {
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
            await page.getByRole('button', { name: 'Создать и подключить', exact: true }).click();
            if (scenario === 'unknown')
              await page.getByRole('button', { name: 'Продолжить подключение' }).click();
            if (scenario === 'partial') {
              await page.getByRole('button', { name: 'Настроить черновик' }).waitFor();
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
            } else await page.getByText('Черновик · магазин ещё не открыт').waitFor();
            const requests = await page.evaluate(() =>
              window.__karavanRequests.filter((item) => item.path.endsWith('/setup')),
            );
            assert.ok(requests.length >= (scenario === 'partial' ? 1 : 2));
            assert.equal(new Set(requests.map((item) => item.body.operationId)).size, 1);
            assert.deepEqual(requests[0].body.chatIds, ['-123', '-456']);
            assert.deepEqual(requests[0].body.create.rules.allowedSubcategoryIds, [
              'services.repair',
            ]);
            assert.equal(requests[0].body.bindingExpectations.length, 2);
          }
          if (['existing', 'existing_unknown'].includes(scenario)) {
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
            await page.getByRole('button', { name: 'Продолжить', exact: true }).click();
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
              await page.getByText('Открыт для покупателей').waitFor();
              const retried = await page.evaluate(
                () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
              );
              assert.deepEqual(retried, initial, 'reload must preserve immutable existing setup');
            } else await page.getByText('Открыт для покупателей').waitFor();
            const request = await page.evaluate(
              () => window.__karavanRequests.find((item) => item.path.endsWith('/setup')).body,
            );
            assert.equal(request.create, undefined);
            assert.equal(request.expectedPolicyRevision, 1);
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
          if (scenario === 'recovery') {
            await page.getByRole('button', { name: 'Восстановить подключение' }).click();
            await page.getByText('Открыт для покупателей').waitFor();
            const body = await page.evaluate(
              () => window.__karavanRequests.find((item) => item.path.includes('/bindings/')).body,
            );
            assert.equal(body.action, 'recover_chat');
            assert.equal(body.expectedBindingGeneration, 1);
          }
          if (scenario === 'disconnect') {
            await page.getByText('Настройки подключения', { exact: true }).click();
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
            await page.getByRole('button', { name: 'Заявки · 3' }).waitFor();
            assert.equal(
              await page.getByRole('button', { name: 'Категории и правила' }).count(),
              0,
            );
          }
          await page.locator('.karavan-module h3').waitFor();
          await geometry(page, `${width}-${theme}-${scenario}`);
          if (scenario === 'draft')
            assert.equal(
              await page.locator('.karavan-module__primary').innerText(),
              'Пригласить продавцов',
            );
          if (scenario === 'active')
            assert.equal(
              await page.locator('.karavan-module__primary').innerText(),
              'Управлять магазином',
            );
          assert.deepEqual(errors, []);
          await page.screenshot({
            path: output + '/' + width + '-' + theme + '-' + scenario + '.png',
            fullPage: true,
          });
        } finally {
          await context.close();
        }
      }
    }
  console.log('Karavan browser: 52 scenarios passed. Screenshots: ' + output);
} finally {
  await browser?.close();
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
function marketplaceName() {
  return 'Магазин соседей — длинное название для проверки переноса';
}
