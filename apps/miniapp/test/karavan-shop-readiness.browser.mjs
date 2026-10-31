import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const providerDirectory = process.env.MARKETPLACE_MODULE_RESPONSE_FIXTURE_DIR;
assert.ok(
  providerDirectory,
  'Run the commerce native module test and supply its private response directory',
);
const scenarios = await Promise.all(
  ['draft-ready', 'paused-ready', 'draft-no-offers', 'paused-no-offers'].map(async (name) => ({
    name,
    response: JSON.parse(await readFile(resolve(providerDirectory, `${name}.json`), 'utf8')),
  })),
);
const directory = resolve(import.meta.dirname, '../build/shop-browser-fixtures');
await mkdir(directory, { recursive: true });
const fixture = await mkdtemp(`${directory}/readiness-`);
await writeFile(
  `${fixture}/index.html`,
  '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="../../../test/karavan-shop-fixture.tsx"></script></body></html>',
);
const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const url = `${base}build/shop-browser-fixtures/${fixture.split('/').at(-1)}/index.html`;
let server;
let checks = 0;
try {
  server = await ensureMiniappDevServer(base);
  for (const [engineName, engine] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await engine.launch(captureBrowserLaunchOptions(engineName, base));
    try {
      for (const theme of ['light', 'dark'])
        for (const scenario of [
          ...scenarios,
          { ...scenarios[0], name: 'draft-older-module', older: true },
          { ...scenarios[2], name: 'draft-partial-module-detail-error', partial: true },
        ]) {
          const original = scenario.response;
          assert.equal(original.counts.listings, 0);
          assert.equal(original.counts.approvedListings, 1);
          const response = structuredClone(original);
          if (scenario.older) {
            delete response.counts.readyListings;
            delete response.counts.approvedListings;
          }
          if (scenario.partial) delete response.counts.approvedListings;
          const context = await browser.newContext({
            viewport: { width: 360, height: 780 },
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
            reducedMotion: 'reduce',
          });
          try {
            await installMaxBridgeShimInitScript(context, {
              platform: engineName === 'webkit' ? 'ios' : 'android',
            });
            await context.addInitScript(
              ({ response, detailCounts }) => {
                window.__shopProviderModule = response;
                window.__shopProviderDetailCounts = detailCounts;
              },
              { response, detailCounts: original.counts },
            );
            await context.route('**/*', (route) =>
              new URL(route.request().url()).origin === new URL(base).origin
                ? route.continue()
                : route.abort(),
            );
            const page = await context.newPage();
            page.setDefaultTimeout(12_000);
            const errors = [];
            page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(
              `${url}?theme=${theme}${scenario.partial ? '&scenario=detail_error' : ''}`,
            );
            await page.getByRole('button', { name: 'Магазин чата', exact: true }).click();
            const home = page.getByRole('dialog', { name: 'Магазин чата', exact: true });
            if (scenario.partial) {
              await home
                .getByText('Не удалось проверить готовность товаров и услуг.', { exact: true })
                .waitFor();
              assert.equal(
                await home
                  .getByRole('button', { name: 'Ссылка для продавцов', exact: true })
                  .count(),
                0,
              );
              await home
                .getByRole('button', { name: 'Повторить проверку товаров', exact: true })
                .click();
            }
            if (original.counts.readyListings > 0) {
              const action = home.getByRole('button', {
                name:
                  original.marketplace.status === 'paused'
                    ? 'Возобновить магазин'
                    : 'Открыть для покупателей',
                exact: true,
              });
              await action.waitFor();
              const before = await page.evaluate(() => window.__shopRequests);
              assert.equal(
                before.filter((row) => row.body?.command?.operation === 'detail').length,
                scenario.older ? 1 : 0,
              );
              await action.click();
              await page.waitForFunction(() =>
                window.__shopRequests.some((row) => row.body?.command?.operation === 'status'),
              );
              const writes = await page.evaluate(() =>
                window.__shopRequests.filter((row) => row.body?.command?.operation === 'status'),
              );
              assert.equal(writes.length, 1);
              assert.equal(writes[0].body.command.input.allowEmpty, false);
              assert.equal(
                await home.getByText('Открыть магазин без продавцов?', { exact: true }).count(),
                0,
              );
            } else {
              await home
                .getByRole('button', { name: 'Проверить товары и услуги', exact: true })
                .waitFor();
              assert.equal(
                await home
                  .getByRole('button', { name: 'Ссылка для продавцов', exact: true })
                  .count(),
                0,
              );
            }
            assert.deepEqual(errors, []);
            checks++;
            console.log(`Provider readiness ${engineName}/${theme}/${scenario.name}: passed`);
          } finally {
            await context.close();
          }
        }
    } finally {
      await browser.close();
    }
  }
  console.log(`Actual commerce producer → Major schema/client → UI: ${checks} checks passed.`);
} finally {
  await stopChildProcess(server);
  await rm(fixture, { recursive: true, force: true });
}
