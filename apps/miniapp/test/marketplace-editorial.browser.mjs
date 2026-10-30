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
import { setPhoneKeyboard, settleVisualFrame } from '../../../scripts/miniapp-smartphone.mjs';

const baseUrl =
  process.env.MINIAPP_MARKETPLACE_TEST_BASE_URL ??
  (await allocateMiniappBaseUrl('http://127.0.0.1:3000/app/'));
const server = await ensureMiniappDevServer(baseUrl, {
  reuseServer: process.env.MINIAPP_MARKETPLACE_TEST_REUSE_SERVER === '1',
});
const output = await mkdtemp(path.join(tmpdir(), 'maxim-marketplace-editorial-'));
console.log(`Editorial screenshots: ${output}`);
const browser = await chromium.launch({ headless: true });
const id = '10000000-0000-4000-8000-000000000001';
const bot = 'https://max.ru/id613000037577_3_bot';
const filter = process.env.MINIAPP_MARKETPLACE_TEST_FILTER
  ? new RegExp(process.env.MINIAPP_MARKETPLACE_TEST_FILTER)
  : null;
const description = 'Общее описание площадки, которое видят все администраторы и посетители.';
const mine = 'Новое описание площадки от второго администратора с достаточным числом символов.';
async function back(page) {
  await page.evaluate(async () => {
    const { runNativeBackHandlers } = await import('/app/src/lib/native-back.ts');
    runNativeBackHandlers();
  });
  await settleVisualFrame(page);
}
async function until(predicate, message) {
  const limit = Date.now() + 8000;
  while (!(await predicate())) {
    if (Date.now() > limit) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
async function refresh(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
let activePage;
let count = 0;
try {
  for (const width of [320, 390])
    for (const theme of ['light', 'dark'])
      for (const profile of ['moderation', 'publisher'])
        for (const kind of ['CHAT', 'CHANNEL']) {
          const key = `${width}-${theme}-${profile}-${kind.toLowerCase()}`;
          if (filter && !filter.test(key)) continue;
          console.log(`Editorial scenario: ${key}`);
          const context = await browser.newContext({
            viewport: { width, height: width === 320 ? 568 : 844 },
            isMobile: true,
            hasTouch: true,
            colorScheme: theme,
          });
          await installMaxBridgeShimInitScript(context, {}, { colorScheme: theme });
          const control = {
            owner: false,
            status: 200,
            entryStatus: 200,
            conflict: false,
            loseReply: false,
            expired: false,
            requests: [],
            editorialReads: 0,
            profileReads: 0,
            profileWrites: 0,
          };
          const state = {
            version: 1,
            entityId: '-100',
            kind,
            revision: 1,
            listing: {
              id,
              title: 'Площадка с общим описанием',
              description,
              profileOnly: kind === 'CHAT',
              publicUrl: `${bot}?startapp=listing_${kind.toLowerCase()}_${id}`,
            },
            ownershipKey: 'a'.repeat(64),
            role: 'EDITOR',
            responsible: { displayName: 'Алексей', profileId: null },
            capabilities: { canEditDescription: true, canManageCommercial: false },
            validUntil: new Date(Date.now() + 30_000).toISOString(),
          };
          const publicState = () => ({
            ...state,
            role: control.owner ? 'RESPONSIBLE' : 'EDITOR',
            capabilities: { canEditDescription: true, canManageCommercial: control.owner },
            validUntil: new Date(Date.now() + (control.expired ? -1000 : 30_000)).toISOString(),
          });
          await context.route('**/*', async (route) => {
            const url = new URL(route.request().url());
            if (url.origin !== new URL(baseUrl).origin) return route.abort();
            if (url.pathname !== '/app/__marketplace-fixture') return route.continue();
            const requested = url.searchParams.get('path') ?? '';
            if (requested.includes('/entry?'))
              return route.fulfill({
                status: control.entryStatus,
                json:
                  control.entryStatus !== 200
                    ? { code: 'ACCESS_DENIED' }
                    : {
                        entityId: '-100',
                        kind,
                        profile,
                        publicState: 'PUBLIC',
                        listing: {
                          id,
                          ownershipKey: state.ownershipKey,
                          title: state.listing.title,
                          publicUrl: state.listing.publicUrl,
                          profileOnly: state.listing.profileOnly,
                        },
                        isOwner: control.owner,
                        canCreate: false,
                        manageUrl: control.owner
                          ? `${bot}?startapp=manage_${kind.toLowerCase()}_${id}`
                          : null,
                        connectUrl: `${bot}?startapp=connect_${kind.toLowerCase()}_-100`,
                        checkedAt: new Date().toISOString(),
                        validUntil: new Date(Date.now() + 300_000).toISOString(),
                      },
              });
            if (requested.includes('/editorial?')) {
              if (route.request().method() === 'GET') control.editorialReads++;
              if (route.request().method() === 'PATCH') {
                const body = route.request().postDataJSON();
                control.requests.push(body);
                if (control.status !== 200)
                  return route.fulfill({ status: control.status, json: { code: 'ACCESS_DENIED' } });
                assert.deepEqual(Object.keys(body).sort(), [
                  'description',
                  'expectedRevision',
                  'listingId',
                  'ownershipKey',
                  'requestId',
                ]);
                if (control.conflict) {
                  control.conflict = false;
                  state.revision++;
                  state.listing.description =
                    'Описание другого администратора, сохранённое во время редактирования карточки.';
                  return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
                }
                if (
                  body.expectedRevision !== state.revision ||
                  body.ownershipKey !== state.ownershipKey ||
                  body.listingId !== state.listing.id
                )
                  return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
                state.listing.description = body.description;
                state.revision++;
                if (control.loseReply) {
                  control.loseReply = false;
                  return route.fulfill({ status: 503, json: { code: 'RESPONSE_LOST' } });
                }
              }
              return route.fulfill({
                status: control.status,
                json: control.status === 200 ? publicState() : { code: 'ACCESS_DENIED' },
              });
            }
            if (requested.includes('/button-policy?'))
              return route.fulfill({
                json: {
                  entityId: '-100',
                  kind,
                  profile,
                  revision: 0,
                  caption: 'Заказать рекламу',
                  captionRevision: 0,
                  contexts: [],
                  buttonDiagnostic: null,
                },
              });
            if (requested.includes('/profile?')) {
              if (route.request().method() !== 'GET') {
                control.profileWrites++;
                return route.fulfill({ status: 403, json: { code: 'FORBIDDEN_TEST_WRITE' } });
              }
              control.profileReads++;
              if (!control.owner)
                return route.fulfill({ status: 403, json: { code: 'ACCESS_DENIED' } });
              const now = new Date().toISOString();
              return route.fulfill({
                json: {
                  bindingId: id,
                  entityId: '-100',
                  kind,
                  revision: state.revision,
                  listing: {
                    ...state.listing,
                    status: 'PUBLISHED',
                    topic: 'Бизнес',
                    region: 'Россия',
                  },
                  choices: { topics: ['Бизнес'], regions: ['Россия'] },
                  capabilities: {
                    canEdit: true,
                    canPublish: true,
                    canPause: true,
                    publicState: 'PUBLIC',
                    placementState: 'READY',
                    manageUrl: `${bot}?startapp=manage_${kind.toLowerCase()}_${id}`,
                    connectUrl: `${bot}?startapp=connect_${kind.toLowerCase()}_-100`,
                  },
                  binding: {
                    id,
                    actorUserId: '100',
                    entityId: '-100',
                    kind,
                    profile,
                    state: 'ACTIVE',
                    revision: 1,
                    checkedAt: now,
                    validUntil: new Date(Date.now() + 300_000).toISOString(),
                    updatedAt: now,
                    generationId: null,
                    statisticsCheckedAt: null,
                    historyComplete: false,
                    historyFrom: null,
                    collectionOwner: 'SHADOW',
                    collectionMetrics: [],
                    statisticsConsent: false,
                    metadata: {
                      title: state.listing.title,
                      description: state.listing.description,
                      imageUrl: null,
                      publicUrl: null,
                      audience: null,
                      isPublic: true,
                    },
                  },
                  appendEnabled: false,
                  statistics: {
                    state: 'EMPTY',
                    observedDays: 0,
                    lastObservedAt: null,
                    from: null,
                    to: null,
                  },
                  appendRevision: 0,
                  available: true,
                  buttonDiagnostic: null,
                },
              });
            }
            return route.fulfill({ status: 404, json: { code: 'UNEXPECTED_ROUTE' } });
          });
          const page = await context.newPage();
          activePage = page;
          page.setDefaultTimeout(8000);
          const errors = [];
          page.on('pageerror', (error) => errors.push(error.message));
          await page.goto(
            `${baseUrl}test/browser/marketplace.html?theme=${theme}&profile=${profile}&kind=${kind.toLowerCase()}`,
          );
          const panel = page.locator('.marketplace-profile-overlay .settings-drilldown__panel');
          await panel.getByRole('button', { name: 'Изменить описание', exact: true }).click();
          const editor = panel.locator('.marketplace-editorial');
          const text = editor.getByRole('textbox', { name: 'Описание площадки', exact: true });
          const save = panel.getByRole('button', { name: 'Сохранить описание', exact: true });
          await until(
            async () => (await text.inputValue()) === description,
            'Canonical description loaded',
          );
          assert.match(await editor.innerText(), /Ответственный: Алексей/u);
          assert.equal(control.profileReads, 0, 'Second admin never opens owner profile relay');
          assert.equal(
            await panel
              .getByRole('button', {
                name: /Условия размещений|Настроить размещения|Опубликовать профиль/u,
              })
              .count(),
            0,
          );
          await text.fill('Коротко');
          assert.equal(
            await save.isEnabled(),
            kind === 'CHAT',
            'Native descriptions require 30 characters',
          );
          await text.fill(mine);
          await setPhoneKeyboard(page, {
            height: 280,
            mode: width === 320 ? 'visual' : 'resize',
          });
          await text.focus();
          await settleVisualFrame(page);
          const reachable = await save.evaluate((element) => {
            const r = element.getBoundingClientRect();
            return (
              r.bottom <=
                (visualViewport?.offsetTop ?? 0) + (visualViewport?.height ?? innerHeight) + 1 &&
              element.contains(
                document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
              )
            );
          });
          assert.equal(reachable, true, 'Save action remains reachable above the keyboard');
          await text.evaluate((element) => element.blur());
          await setPhoneKeyboard(page, {
            mode: width === 320 ? 'visual' : 'resize',
            open: false,
          });
          await back(page);
          await panel.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
          await panel
            .getByRole('textbox', { name: 'Текст рекламной кнопки', exact: true })
            .fill('Написать о рекламе');
          await back(page);
          await panel.getByRole('button', { name: 'Изменить описание', exact: true }).click();
          assert.equal(await text.inputValue(), mine, 'Back preserves independent editorial draft');
          control.conflict = true;
          await save.click();
          await editor
            .getByRole('button', { name: 'Использовать мой вариант', exact: true })
            .waitFor();
          assert.equal(await text.inputValue(), mine);
          assert.equal(await save.isEnabled(), false);
          await editor.getByText('Сохранённое описание', { exact: true }).click();
          await page.screenshot({ path: path.join(output, `${key}-conflict.png`) });
          const firstRequest = control.requests.at(-1).requestId;
          await editor
            .getByRole('button', { name: 'Использовать мой вариант', exact: true })
            .click();
          await save.click();
          await editor.getByText('Описание сохранено.', { exact: true }).waitFor();
          assert.notEqual(
            control.requests.at(-1).requestId,
            firstRequest,
            'Rebased command has a new idempotency key',
          );
          assert.equal(state.listing.description, mine);
          assert.equal(control.profileWrites, 0);
          await page.screenshot({ path: path.join(output, `${key}-saved.png`) });
          await text.fill(`${mine} Уточнение.`);
          control.loseReply = true;
          await save.click();
          await until(
            async () => (await save.count()) === 0,
            'Lost reply resolved by newer same-card read',
          );
          await text.fill(`${mine} Черновик перед проверкой доступа.`);
          const draft = await text.inputValue();
          const readsBeforeExpiry = control.editorialReads;
          control.expired = true;
          await refresh(page);
          await until(async () => !(await save.isEnabled()), 'Expired proof disables save');
          assert.equal(await text.inputValue(), draft);
          await new Promise((resolve) => setTimeout(resolve, 150));
          assert.ok(
            control.editorialReads <= readsBeforeExpiry + 3,
            'Expired reply does not spin a refresh loop',
          );
          assert.equal(
            await editor.getByText('Ответственный: Алексей', { exact: true }).count(),
            0,
          );
          control.expired = false;
          await editor.getByRole('button', { name: 'Проверить снова', exact: true }).click();
          await until(async () => await save.isEnabled(), 'Fresh proof restores save');
          control.status = 403;
          await save.click();
          await until(
            async () => !(await save.isEnabled()),
            'Denied mutation disables old capability',
          );
          assert.equal(await text.inputValue(), draft);
          await page.screenshot({ path: path.join(output, `${key}-denied.png`) });
          control.status = 200;
          await editor.getByRole('button', { name: 'Проверить снова', exact: true }).click();
          await until(async () => await save.isEnabled(), 'Explicit successful access recovery');
          state.ownershipKey = 'b'.repeat(64);
          await refresh(page);
          await editor
            .getByText(
              'Ответственный или карточка изменились. Ваш текст сохранён. Откройте карточку заново.',
              { exact: true },
            )
            .waitFor();
          assert.equal(
            await save.isEnabled(),
            false,
            'Old draft cannot silently follow new responsibility',
          );
          await back(page);
          await back(page);
          await page.getByRole('button', { name: 'Выйти без сохранения', exact: true }).click();
          control.owner = true;
          await page.getByRole('button', { name: 'Открыть снова', exact: true }).click();
          await panel.getByRole('button', { name: 'Условия размещений', exact: true }).waitFor();
          await panel.getByRole('button', { name: 'Изменить описание', exact: true }).click();
          await until(
            async () => (await text.inputValue()) === state.listing.description,
            'Owner opens same description',
          );
          await text.fill(`${mine} Изменение ответственного.`);
          await save.click();
          await editor.getByText('Описание сохранено.', { exact: true }).waitFor();
          assert.equal(
            control.profileWrites,
            0,
            'Responsible description also uses narrow endpoint',
          );
          assert.deepEqual(errors, []);
          count++;
          await context.close();
          activePage = null;
        }
  console.log(`Editorial browser passed: ${count} scenarios; ${output}`);
} catch (error) {
  if (activePage)
    await activePage.screenshot({ path: path.join(output, 'failure.png') }).catch(() => undefined);
  throw error;
} finally {
  await browser.close();
  await stopChildProcess(server);
}
