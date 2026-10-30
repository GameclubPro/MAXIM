import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const fixtures = resolve(import.meta.dirname, '../build/storefront-browser-fixtures');
await mkdir(fixtures, { recursive: true });
const fixture = await mkdtemp(`${fixtures}/section-`);
const output = await mkdtemp('/tmp/maxim-storefront-section-');
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/storefront-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
const scenarios = process.env.STOREFRONT_BROWSER_SCENARIOS?.split(',') ?? [
  'disabled',
  'off',
  'loading',
  'error',
];
assert.ok(
  scenarios.length > 0 &&
    scenarios.every((item) => ['disabled', 'off', 'loading', 'error'].includes(item)),
  'Unknown storefront browser scenario',
);
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>',
);
await writeFile(
  `${fixture}/fixture.tsx`,
  `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import type {ApiTransport} from '../../../src/lib/api/transport';
import {ToastProvider} from '../../../src/components/ui/toast';
import {SettingsStorefrontSection} from '../../../src/pages/settings/settings-storefront-section';
import {SharedChatSettingsSection} from '../../../src/pages/settings/shared-chat-settings-section';
import {createChatSettingsFieldAdapter} from '../../../src/features/network-settings/settings-field-bindings';
import {chatSettingsSchema} from '@maxim/contracts/settings';
import '../../../src/styles.css';
// Load the actual route and shell styles, including lazy settings dependencies.
import '../../../src/pages/settings-page';
import '../../../src/styles/moderation-workspace.css';
const params=new URLSearchParams(location.search);
const scenario=params.get('scenario');
document.documentElement.dataset.maxTheme=params.get('theme') || 'light';
document.body.dataset.miniappProfile='moderation';
document.body.classList.add('settings-home-page-open');
window.__requests=[]; window.__saves=[];
let reads=0;
const api={request:async(path,init={})=>{
  window.__requests.push({path,method:init.method||'GET'});
  if(path.endsWith('/karavan-storefront/allowlist?limit=100')) return {items:[],nextCursor:null};
  if(!path.endsWith('/karavan-marketplace')) throw new Error('Unexpected request: '+path);
  if(scenario==='error' && reads++===0) throw new Error('Offline');
  if(scenario==='loading') return new Promise(resolve=>{window.__resolveShop=()=>resolve({enabled:false});});
  return {enabled:false};
},requestKeepalive:()=>{}} satisfies ApiTransport;
const initial=chatSettingsSchema.parse({karavanStorefrontEnabled:scenario!=='off',karavanStorefrontAdminsOnly:false,karavanStorefrontMessageText:'',karavanStorefrontOpenButtonText:'',karavanStorefrontCatalogButtonText:'',karavanStorefrontCreateButtonText:''});
function Harness(){
  const [open,setOpen]=React.useState(false);
  const [draft,setDraft]=React.useState(initial);
  const [saved,setSaved]=React.useState(initial);
  const change=(field,value)=>setDraft(current=>({...current,[field]:value}));
  const fields=createChatSettingsFieldAdapter({settings:draft,baseline:saved,onChange:setDraft});
  return <SettingsStorefrontSection api={api} chatId="-123" draft={draft} expanded={open} summary="" status=""
    sharedContent={<SharedChatSettingsSection section="storefront" fields={fields} context={{mode:'single',api}}/>}
    hasChanges={JSON.stringify(draft)!==JSON.stringify(saved)} onToggleSection={()=>setOpen(value=>!value)}
    onDiscardChanges={()=>setDraft(saved)} onFieldChange={value=>change('karavanStorefrontEnabled',value)}
    onAdminsOnlyChange={value=>change('karavanStorefrontAdminsOnly',value)} onTextChange={change}
    footer={<button onClick={()=>{window.__saves.push(draft);setSaved(draft);}}>Сохранить</button>}/>;
}
createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}})}><ToastProvider><Harness/></ToastProvider></QueryClientProvider>);
`,
);

let server;
let passed = 0;
try {
  server = await ensureMiniappDevServer(base);
  for (const [engineName, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const width of process.env.STOREFRONT_BROWSER_WIDTH
        ? [Number(process.env.STOREFRONT_BROWSER_WIDTH)]
        : [320, 360, 390, 430]) {
        for (const theme of ['light', 'dark']) {
          for (const scenario of scenarios) {
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
              await installMaxBridgeShimInitScript(context, {
                platform: engineName === 'webkit' ? 'ios' : 'android',
              });
              const page = await context.newPage();
              page.setDefaultTimeout(10_000);
              const errors = [];
              page.on('pageerror', (error) => errors.push(error.message));
              await page.goto(`${url}?theme=${theme}&scenario=${scenario}`);
              await page.getByRole('button', { name: 'Интернет-витрина', exact: true }).click();
              const rootSheet = page.getByRole('dialog', { name: 'Интернет-витрина', exact: true });
              let sheet = rootSheet;
              await sheet.waitFor();
              if (scenario === 'loading') {
                await sheet
                  .getByRole('status', { name: 'Проверяем магазин', exact: true })
                  .waitFor();
                await page.waitForFunction(() => typeof window.__resolveShop === 'function');
                await page.evaluate(() => window.__resolveShop());
              }
              if (scenario === 'error') {
                await sheet
                  .getByRole('alert')
                  .filter({ hasText: 'Не удалось проверить магазин.' })
                  .waitFor();
                await sheet.getByRole('button', { name: 'Повторить', exact: true }).click();
              }
              await sheet.getByText('Магазин чата пока недоступен.', { exact: true }).waitFor();
              await sheet.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
              sheet = page.getByRole('dialog', { name: 'Кнопки в чате', exact: true });
              const toggle = sheet.getByRole('checkbox', {
                name: 'Ответ бота на $',
              });
              await toggle.waitFor({ state: 'visible' });
              await settleVisualFrame(page);
              const label = `${engineName}-${width}-${theme}-${scenario}`;
              assert.equal(
                await sheet.getByRole('button', { name: 'Подключить магазин' }).count(),
                0,
              );
              assert.equal(await toggle.isChecked(), scenario !== 'off');
              assert.equal(
                await sheet.locator('#karavanStorefrontMessageText').isVisible(),
                false,
                'text editing starts collapsed',
              );
              if (scenario !== 'off') {
                await sheet.getByText('Изменить текст', { exact: true }).click();
                await sheet.locator('#karavanStorefrontMessageText').waitFor();
                assert.equal(
                  await sheet.locator('.settings-storefront-editor__preview').count(),
                  0,
                  'unavailable marketplace does not invent a bot response',
                );
              }
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
                true,
                `${label}: page overflow`,
              );
              const bounds = await sheet
                .locator('.settings-storefront__publications')
                .evaluate((node) => {
                  const rect = node.getBoundingClientRect();
                  const summary = node
                    .querySelector('.settings-native-switch')
                    .getBoundingClientRect();
                  return {
                    left: rect.left,
                    right: rect.right,
                    height: summary.height,
                    overflow: node.scrollWidth > node.clientWidth + 1,
                  };
                });
              assert.ok(
                bounds.left >= 0 &&
                  bounds.right <= width + 1 &&
                  bounds.height >= 44 &&
                  !bounds.overflow,
                `${label}: publication layout`,
              );
              const presentation = await sheet.evaluate((node) => {
                const rect = node.getBoundingClientRect();
                const close = node
                  .querySelector('button[aria-label="Закрыть панель"]')
                  .getBoundingClientRect();
                const toggle = node
                  .querySelector('.settings-native-switch')
                  .getBoundingClientRect();
                return { width: rect.width, close: close.width, toggle: toggle.width };
              });
              assert.ok(
                presentation.width >= width - 32 &&
                  presentation.close >= 40 &&
                  presentation.toggle >= 44,
                `${label}: actual sheet and switch styles must be loaded`,
              );
              await page.screenshot({ path: `${output}/${label}.png` });
              await toggle.setChecked(scenario === 'off');
              assert.deepEqual(
                await page.evaluate(() => window.__saves),
                [],
                'draft changes require explicit save',
              );
              await sheet.getByRole('button', { name: 'Сохранить', exact: true }).click();
              assert.equal(
                await page.evaluate(() => window.__saves.at(-1).karavanStorefrontEnabled),
                scenario === 'off',
              );
              await page.keyboard.press('Escape');
              await rootSheet.getByRole('button', { name: 'Кнопки в чате', exact: true }).click();
              await toggle.waitFor({ state: 'visible' });
              assert.equal(
                await toggle.isChecked(),
                scenario === 'off',
                'warm reopen preserves saved state',
              );
              assert.deepEqual(
                await page.evaluate(() =>
                  window.__requests.filter((item) => item.method !== 'GET'),
                ),
                [],
                'opening settings never activates the marketplace',
              );
              assert.deepEqual(errors, []);
              passed++;
            } finally {
              await context.close();
            }
          }
          console.log(
            `Storefront section: ${engineName}/${width}/${theme} passed (${passed} cases).`,
          );
        }
      }
    } finally {
      await browser.close();
    }
  }
  console.log(`Storefront section: ${passed} cases passed. Screenshots: ${output}`);
} finally {
  if (server) await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
