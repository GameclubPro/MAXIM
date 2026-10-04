import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
const baseUrl = await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/');
const server = await ensureMiniappDevServer(baseUrl);
const output = await mkdtemp(path.join(tmpdir(), 'maxim-marketplace-states-'));
const browser = await chromium.launch({ headless: true });
const bot = 'https://max.ru/id613000037577_3_bot';
const id = '10000000-0000-4000-8000-000000000001';
function fixture() {
  return {
    bindingId: id,
    entityId: '-100',
    kind: 'CHANNEL',
    revision: 1,
    listing: {
      id,
      status: 'PUBLISHED',
      title: 'Мой канал',
      description: 'Описание канала',
      topic: 'Бизнес',
      region: 'Россия',
      publicUrl: `${bot}?startapp=listing_channel_${id}`,
      profileOnly: false,
    },
    choices: { topics: ['Бизнес'], regions: ['Россия'] },
    capabilities: {
      canEdit: true,
      canPublish: true,
      canPause: true,
      publicState: 'PUBLIC',
      placementState: 'SETUP_REQUIRED',
      manageUrl: `${bot}?startapp=manage_channel_${id}`,
      connectUrl: `${bot}?startapp=connect_channel_-100`,
    },
    statistics: {
      state: 'AVAILABLE',
      observedDays: 2,
      lastObservedAt: '2026-10-01T14:00:00.000Z',
      from: '2026-07-07T00:00:00.000Z',
      to: '2026-10-04T14:00:00.000Z',
    },
    appendEnabled: false,
    appendRevision: 0,
    available: true,
    buttonDiagnostic: null,
    binding: {
      id,
      actorUserId: '100',
      entityId: '-100',
      kind: 'CHANNEL',
      profile: 'publisher',
      state: 'ACTIVE',
      revision: 1,
      checkedAt: '2026-10-04T14:00:00.000Z',
      validUntil: '2026-10-04T14:05:00.000Z',
      updatedAt: '2026-10-04T14:00:00.000Z',
      generationId: null,
      statisticsCheckedAt: '2026-10-04T14:00:00.000Z',
      historyComplete: false,
      historyFrom: null,
      collectionOwner: 'SHADOW',
      collectionMetrics: [],
      statisticsConsent: true,
      metadata: {
        title: 'Мой канал',
        description: 'Описание канала',
        imageUrl: null,
        publicUrl: null,
        audience: 200,
        isPublic: true,
      },
    },
  };
}
try {
  for (const width of [320, 390])
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: width === 320 ? 568 : 844 },
        isMobile: true,
        hasTouch: true,
        colorScheme: theme,
      });
      await installMaxBridgeShimInitScript(context, {}, { colorScheme: theme });
      let state = fixture(),
        code = 'MARKETPLACE_ACCESS_PENDING',
        status = 503,
        reads = 0;
      const mutations = [];
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) return route.abort();
        if (url.pathname !== '/app/__marketplace-fixture') return route.continue();
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          mutations.push(body);
          if (body.action === 'save') {
            state.listing = { ...state.listing, ...body.details };
            state.revision++;
          }
          return route.fulfill({ json: state });
        }
        reads++;
        return status === 200
          ? route.fulfill({ json: state })
          : route.fulfill({ status, json: { code } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${baseUrl}test/browser/marketplace.html?theme=${theme}`);
      const workspace = page.locator('.marketplace-profile');
      await workspace.getByText('Проверяем ваши права…', { exact: true }).waitFor();
      assert.equal(
        await workspace.getByRole('alert').count(),
        0,
        'Pending permission is not an error',
      );
      assert.equal(
        await workspace.getByRole('button', { name: /Опубликовать|Сохранить/ }).count(),
        0,
      );
      await page.screenshot({ path: path.join(output, `${width}-${theme}-pending.png`) });
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      await workspace.getByRole('button', { name: 'Проверить снова', exact: true }).click();
      await workspace.getByRole('alert').waitFor();
      assert.match(await workspace.textContent(), /Не удалось получить состояние/u);
      status = 200;
      await workspace.getByRole('button', { name: 'Проверить снова', exact: true }).click();
      await workspace.getByRole('button', { name: 'Настроить размещения', exact: true }).waitFor();
      assert.match(await workspace.textContent(), /Даты с замерами: 2/u);
      assert.match(
        await workspace.textContent(),
        /1 окт.*17:00/u,
        'Uses observation timestamp, not synchronization timestamp',
      );
      assert.equal(
        await workspace
          .getByRole('button', { name: 'Подключить бота «Связки»', exact: true })
          .count(),
        0,
      );
      await page.screenshot({ path: path.join(output, `${width}-${theme}-summary.png`) });
      await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).click();
      await workspace.getByLabel('Название', { exact: true }).fill('Мой сохранённый ввод');
      state.revision++;
      state.listing.title = 'Изменено на бирже';
      await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
      await workspace
        .getByText('Профиль изменился во время редактирования.', { exact: false })
        .waitFor();
      assert.equal(
        await workspace.getByLabel('Название', { exact: true }).inputValue(),
        'Мой сохранённый ввод',
      );
      assert.equal(
        await workspace
          .getByRole('button', { name: 'Сохранить изменения', exact: true })
          .isDisabled(),
        true,
      );
      await workspace
        .getByRole('button', { name: 'Использовать мой вариант', exact: true })
        .click();
      await workspace.getByRole('button', { name: 'Сохранить изменения', exact: true }).click();
      await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).waitFor();
      assert.equal(mutations.at(-1).expectedRevision, 2);
      assert.equal(mutations.at(-1).statisticsConsent, undefined);
      status = 403;
      code = 'ACCESS_DENIED';
      await workspace.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
      await workspace.getByText('Не удалось обновить состояние', { exact: true }).waitFor();
      assert.equal(
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).isDisabled(),
        true,
      );
      const beforeClose = reads;
      await page.locator('.settings-drilldown__close').click();
      await page.getByRole('button', { name: 'Открыть снова', exact: true }).waitFor();
      await page.waitForTimeout(150);
      assert.equal(reads, beforeClose, 'Closed workspace stops requests');
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(`Marketplace states: four browser matrices passed; screenshots: ${output}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
