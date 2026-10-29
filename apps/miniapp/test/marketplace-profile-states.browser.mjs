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
console.log(`Marketplace state screenshots: ${output}`);
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
      checkedAt: new Date().toISOString(),
      validUntil: new Date(Date.now() + 300_000).toISOString(),
      updatedAt: new Date().toISOString(),
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
async function returnToApp(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
async function nativeBack(page) {
  // The component fixture has no app-level MAX bridge subscription.
  // Exercise the real registered handlers; the full-app matrix covers the bridge.
  await page.evaluate(async () => {
    const { runNativeBackHandlers } = await import('/app/src/lib/native-back.ts');
    runNativeBackHandlers();
  });
}
async function waitUntil(predicate, message) {
  const deadline = Date.now() + 7000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
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
        isOwner = true,
        entryValidUntil = null,
        policyStatus = 200,
        policyFailure = null,
        forcedPolicyState = null;
      const reads = { entry: 0, profile: 0, policy: 0 };
      const mutations = [],
        policyMutations = [];
      const policy = {
        entityId: '-100',
        kind: 'CHANNEL',
        profile: 'publisher',
        revision: 0,
        contexts: [
          {
            context: 'PUBLICATIONS',
            enabled: false,
            effective: false,
            status: 'OFF',
            enabledAt: null,
          },
        ],
        buttonDiagnostic: null,
      };
      const policyView = () => {
        const item = policy.contexts[0];
        item.status = !item.enabled
          ? 'OFF'
          : (forcedPolicyState ??
            (state.capabilities.publicState === 'PUBLIC' ? 'READY' : 'PROFILE_UNAVAILABLE'));
        item.effective = item.enabled && item.status === 'READY';
        return structuredClone(policy);
      };
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(baseUrl).origin) return route.abort();
        if (url.pathname !== '/app/__marketplace-fixture') return route.continue();
        const requestedPath = url.searchParams.get('path') ?? '';
        if (requestedPath.includes('/entry?')) {
          reads.entry++;
          if (status !== 200) return route.fulfill({ status, json: { code } });
          const publicNow = state.capabilities.publicState === 'PUBLIC';
          return route.fulfill({
            json: {
              entityId: state.entityId,
              kind: state.kind,
              profile: 'publisher',
              publicState: state.capabilities.publicState,
              listing:
                state.listing && (isOwner || publicNow)
                  ? {
                      id: state.listing.id,
                      ownershipKey: 'a'.repeat(64),
                      title: state.listing.title,
                      publicUrl: publicNow ? state.listing.publicUrl : null,
                      profileOnly: state.listing.profileOnly,
                    }
                  : null,
              isOwner,
              canCreate: false,
              manageUrl: isOwner ? state.capabilities.manageUrl : null,
              connectUrl: state.capabilities.connectUrl,
              checkedAt: new Date().toISOString(),
              validUntil: entryValidUntil ?? new Date(Date.now() + 300_000).toISOString(),
            },
          });
        }
        if (requestedPath.includes('/button-policy?')) {
          if (route.request().method() === 'GET') {
            reads.policy++;
            return policyStatus === 200
              ? route.fulfill({ json: policyView() })
              : route.fulfill({ status: policyStatus, json: { code: 'ACCESS_DENIED' } });
          }
          const body = route.request().postDataJSON();
          policyMutations.push(body);
          if (policyStatus !== 200)
            return route.fulfill({ status: policyStatus, json: { code: 'ACCESS_DENIED' } });
          if (policyFailure === 'conflict') {
            policyFailure = null;
            policy.revision++;
            policy.contexts[0].enabled = true;
            return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
          }
          if (body.expectedRevision !== policy.revision)
            return route.fulfill({ status: 409, json: { code: 'REVISION_CONFLICT' } });
          if (policyFailure === 'unconfirmed-reconfirmation') {
            policyFailure = null;
            policy.revision++;
            return route.fulfill({ status: 503, json: { code: 'RESPONSE_LOST' } });
          }
          policy.contexts[0].enabled = body.enabled;
          policy.contexts[0].enabledAt = body.enabled ? new Date().toISOString() : null;
          policy.revision++;
          forcedPolicyState = null;
          if (policyFailure === 'unknown-result') {
            policyFailure = null;
            return route.fulfill({ status: 503, json: { code: 'RESPONSE_LOST' } });
          }
          return route.fulfill({ json: policyView() });
        }
        if (route.request().method() === 'POST') {
          const body = route.request().postDataJSON();
          mutations.push(body);
          if (body.action === 'save') {
            state.listing = { ...state.listing, ...body.details };
            state.revision++;
          }
          return route.fulfill({ json: state });
        }
        reads.profile++;
        if (!isOwner) return route.fulfill({ status: 403, json: { code: 'ACCESS_DENIED' } });
        return status === 200
          ? route.fulfill({ json: state })
          : route.fulfill({ status, json: { code } });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${baseUrl}test/browser/marketplace.html?theme=${theme}`);
      const panel = page.locator('.marketplace-profile-overlay .settings-drilldown__panel');
      const workspace = page.locator('.marketplace-entry');
      await panel.getByText('Проверяем ваши права…', { exact: true }).waitFor();
      assert.equal(await panel.getByRole('alert').count(), 0, 'Pending permission is not an error');
      assert.equal(await panel.getByRole('button', { name: /Опубликовать|Сохранить/ }).count(), 0);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-pending.png`) });
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      await panel.getByRole('button', { name: 'Проверить снова', exact: true }).click();
      await panel.getByRole('alert').waitFor();
      assert.match(await panel.innerText(), /Не удалось получить профиль/u);
      status = 200;
      await panel.getByRole('button', { name: 'Проверить снова', exact: true }).click();
      await workspace.getByRole('button', { name: 'Настроить размещения', exact: true }).waitFor();
      assert.doesNotMatch(
        await workspace.innerText(),
        /Дней со статистикой|Период:|Условия не настроены/u,
      );
      assert.equal(await workspace.getByRole('checkbox').count(), 0);
      assert.equal(
        await workspace.getByRole('button', { name: 'Подключить бота', exact: true }).count(),
        0,
      );
      await page.screenshot({ path: path.join(output, `${width}-${theme}-summary.png`) });
      await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).click();
      assert.match(await workspace.innerText(), /Дней со статистикой: 2/u);
      assert.match(
        await workspace.innerText(),
        /1 окт.*17:00/u,
        'Uses observation timestamp, not synchronization timestamp',
      );
      await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).click();
      await workspace.getByLabel('Название', { exact: true }).fill('Мой сохранённый ввод');
      state.statistics.state = 'DISABLED';
      state.binding.statisticsConsent = false;
      await returnToApp(page);
      await workspace.getByText('Профиль пока недоступен.', { exact: true }).waitFor();
      await workspace.getByLabel('Название', { exact: true }).fill('Полностью заполненная форма');
      assert.equal(
        await workspace
          .getByRole('button', { name: 'Сохранить изменения', exact: true })
          .isDisabled(),
        true,
        'A complete form cannot grant its own access',
      );
      assert.equal(mutations.length, 0, 'Unavailable profile sends no write');
      state.statistics.state = 'AVAILABLE';
      state.binding.statisticsConsent = true;
      await returnToApp(page);
      await waitUntil(
        () =>
          workspace.getByRole('button', { name: 'Сохранить изменения', exact: true }).isEnabled(),
        'Only a successful server recheck can restore saving',
      );
      await workspace.getByLabel('Название', { exact: true }).fill('Мой сохранённый ввод');
      state.revision++;
      state.listing.title = 'Изменено на бирже';
      await returnToApp(page);
      await workspace
        .getByText('Профиль изменился. Ваш ввод сохранён.', { exact: false })
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
      await returnToApp(page);
      await workspace.getByText('Не удалось обновить состояние', { exact: true }).waitFor();
      assert.equal(
        await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await workspace.getByRole('button', { name: 'Скрыть профиль', exact: true }).isDisabled(),
        true,
      );
      status = 200;
      await returnToApp(page);
      await waitUntil(
        () => workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).isEnabled(),
        'Rights recovery must refresh the profile',
      );
      await nativeBack(page);
      await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).click();
      await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).click();
      await workspace.getByLabel('Название', { exact: true }).fill('Черновик при смене владельца');
      isOwner = false;
      await returnToApp(page);
      const saveAfterRoleChange = workspace.getByRole('button', {
        name: 'Сохранить изменения',
        exact: true,
      });
      await waitUntil(
        () => saveAfterRoleChange.isDisabled(),
        'Losing ownership must block writes while preserving the editor',
      );
      assert.equal(
        await workspace.getByLabel('Название', { exact: true }).inputValue(),
        'Черновик при смене владельца',
      );
      const privateReadsAfterRoleChange = reads.profile;
      const entryReadsAfterRoleChange = reads.entry;
      await returnToApp(page);
      await waitUntil(
        () => reads.entry > entryReadsAfterRoleChange,
        'A further return still checks the public entry',
      );
      assert.equal(
        reads.profile,
        privateReadsAfterRoleChange,
        'Lost ownership prevents further private profile reads',
      );
      await nativeBack(page);
      await page.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
      assert.equal(
        await workspace.getByLabel('Название', { exact: true }).inputValue(),
        'Черновик при смене владельца',
      );
      await nativeBack(page);
      await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
      assert.equal(
        await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).count(),
        0,
      );
      assert.equal(await panel.locator('.settings-drilldown__close').isEnabled(), true);
      isOwner = true;
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Настроить размещения', exact: true }).waitFor();
      state.listing.status = 'DRAFT';
      state.capabilities.publicState = 'DRAFT';
      state.listing.topic = '';
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Продолжить настройку', exact: true }).click();
      await workspace.getByLabel('Название', { exact: true }).waitFor();
      assert.equal(await workspace.getByLabel('Тематика', { exact: true }).inputValue(), '');
      await nativeBack(page);
      await workspace.getByRole('button', { name: 'Продолжить настройку', exact: true }).waitFor();
      state.listing.topic = 'Бизнес';
      state.capabilities.publicState = 'REVIEW';
      await returnToApp(page);
      await workspace.getByText('На проверке', { exact: true }).waitFor();
      await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).click();
      assert.equal(
        await workspace.getByRole('button', { name: 'Опубликовать профиль', exact: true }).count(),
        0,
        'Review status must not offer a publish action',
      );
      assert.doesNotMatch(await workspace.innerText(), /Профиль будет виден/u);
      await nativeBack(page);
      state.listing.status = 'PUBLISHED';
      state.capabilities.publicState = 'PUBLIC';
      state.capabilities.placementState = 'READY';
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Условия размещений', exact: true }).waitFor();
      assert.equal(
        await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).count(),
        1,
      );
      assert.equal(
        await workspace.getByRole('button', { name: 'Настроить размещения', exact: true }).count(),
        0,
      );
      const beforeExpiryReads = reads.profile;
      state.binding.validUntil = new Date(Date.now() + 600).toISOString();
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Проверить доступ', exact: true }).waitFor();
      assert.ok(
        reads.profile >= beforeExpiryReads + 2,
        'Explicit expiry refreshes access without waiting for focus or polling',
      );
      assert.equal(
        await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).count(),
        0,
        'Expired access cannot keep a cached public action active',
      );
      state.binding.validUntil = new Date(Date.now() + 300_000).toISOString();
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      state.capabilities.publicState = 'HIDDEN';
      state.listing.status = 'PAUSED';
      await returnToApp(page);
      await waitUntil(
        async () =>
          (await workspace
            .getByRole('button', { name: 'Посмотреть профиль', exact: true })
            .count()) === 0,
        'READY must not override hidden public state',
      );
      await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).click();
      await workspace.getByRole('button', { name: 'Изменить профиль', exact: true }).waitFor();
      assert.equal(
        await workspace.getByLabel('Название', { exact: true }).count(),
        0,
        'Hidden profile opens details before editing',
      );
      await nativeBack(page);
      state.capabilities.publicState = 'PUBLIC';
      state.listing.status = 'PUBLISHED';
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      await workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
      const toggle = workspace.getByRole('checkbox', {
        name: 'В публикациях Публика',
        exact: true,
      });
      await toggle.waitFor();
      policyFailure = 'unknown-result';
      const beforeUnknownReads = reads.policy;
      await toggle.click();
      await waitUntil(
        async () =>
          reads.policy > beforeUnknownReads &&
          (await toggle.isChecked()) &&
          (await toggle.isEnabled()),
        'Unknown mutation must reconcile the actually saved choice',
      );
      assert.equal(
        policyMutations.length,
        1,
        'Ambiguous response must not cause an automatic write replay',
      );
      assert.equal(policyMutations[0].context, 'PUBLICATIONS');
      assert.equal(policyMutations[0].statisticsConsent, undefined);
      assert.equal(policy.contexts[0].enabled, true);
      forcedPolicyState = 'CONFIRM_REQUIRED';
      await returnToApp(page);
      const confirmation = workspace.getByRole('button', {
        name: 'Подтвердить включение',
        exact: true,
      });
      await confirmation.waitFor();
      assert.equal(
        await toggle.isChecked(),
        true,
        'Consent stays selected while confirmation is required',
      );
      policyFailure = 'unconfirmed-reconfirmation';
      const beforeReconfirmation = policyMutations.length;
      await confirmation.click();
      await workspace
        .getByText('Сохранение не подтверждено. Проверьте настройки и повторите.', { exact: true })
        .waitFor();
      assert.equal(await confirmation.isEnabled(), true);
      assert.equal(await toggle.isChecked(), true);
      assert.equal(policyMutations.length, beforeReconfirmation + 1);
      assert.equal(
        forcedPolicyState,
        'CONFIRM_REQUIRED',
        'A newer still-unconfirmed setting must not imply successful reconfirmation',
      );
      await confirmation.click();
      await confirmation.waitFor({ state: 'hidden' });
      assert.equal(policyMutations.at(-1).enabled, true);
      policy.buttonDiagnostic = 'KEYBOARD_FULL';
      await returnToApp(page);
      await workspace
        .getByText('Под сообщением нет места для ещё одной кнопки.', { exact: true })
        .waitFor();
      assert.equal(await toggle.isChecked(), true);
      policyFailure = 'conflict';
      await toggle.click();
      await workspace
        .getByText('Настройки изменил другой администратор.', { exact: false })
        .waitFor();
      await waitUntil(
        async () => (await toggle.isChecked()) && (await toggle.isEnabled()),
        'Conflict must preserve the newer server choice',
      );
      await toggle.click();
      await waitUntil(
        async () => !(await toggle.isChecked()),
        'A repeated explicit choice uses the refreshed revision',
      );
      assert.equal(policyMutations.at(-1).expectedRevision, policy.revision - 1);
      await toggle.click();
      await waitUntil(() => toggle.isChecked(), 'Policy can be enabled after conflict recovery');
      policy.buttonDiagnostic = null;
      status = 503;
      code = 'SERVICE_UNAVAILABLE';
      await returnToApp(page);
      const retryProfile = workspace.getByRole('button', {
        name: 'Проверить профиль',
        exact: true,
      });
      await retryProfile.waitFor();
      assert.doesNotMatch(await workspace.innerText(), /Для кнопки нужен опубликованный профиль/u);
      assert.equal(await toggle.isChecked(), true);
      assert.equal(
        await toggle.isEnabled(),
        true,
        'A failed profile check cannot block withdrawal of saved consent',
      );
      await toggle.click();
      await waitUntil(
        async () => !(await toggle.isChecked()) && (await toggle.isDisabled()),
        'New enabling stays blocked while the public profile is unverified',
      );
      status = 200;
      await retryProfile.click();
      await waitUntil(() => toggle.isEnabled(), 'Profile retry restores the verified access');
      await toggle.click();
      await waitUntil(
        async () => (await toggle.isChecked()) && (await toggle.isEnabled()),
        'Policy saves normally after profile recovery',
      );
      const beforePolicyExpiryReads = reads.entry;
      entryValidUntil = new Date(Date.now() + 600).toISOString();
      await returnToApp(page);
      await retryProfile.waitFor();
      assert.ok(reads.entry >= beforePolicyExpiryReads + 2);
      assert.doesNotMatch(await workspace.innerText(), /Для кнопки нужен опубликованный профиль/u);
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await toggle.isEnabled(), true);
      entryValidUntil = null;
      await retryProfile.click();
      await retryProfile.waitFor({ state: 'hidden' });
      state.capabilities.publicState = 'HIDDEN';
      state.listing.status = 'PAUSED';
      await returnToApp(page);
      await workspace.getByText('Профиль недоступен посетителям.', { exact: true }).waitFor();
      assert.equal(await toggle.isChecked(), true);
      assert.equal(
        await toggle.isDisabled(),
        false,
        'Hidden profile cannot prevent withdrawal of existing consent',
      );
      await toggle.click();
      await waitUntil(
        async () => !(await toggle.isChecked()) && (await toggle.isDisabled()),
        'Withdrawing consent succeeds while new enabling remains blocked',
      );
      policy.contexts[0].enabled = true;
      policyStatus = 403;
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Проверить настройки', exact: true }).waitFor();
      assert.equal(
        await toggle.isDisabled(),
        true,
        'Actual administrator denial fences all policy writes',
      );
      policyStatus = 200;
      state.capabilities.publicState = 'PUBLIC';
      state.listing.status = 'PUBLISHED';
      policy.buttonDiagnostic = null;
      isOwner = false;
      const ownerReads = reads.profile;
      await page.reload();
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      assert.equal(
        await workspace.getByRole('button', { name: 'Настройки профиля', exact: true }).count(),
        0,
      );
      assert.equal(await workspace.getByLabel('Название', { exact: true }).count(), 0);
      assert.equal(
        reads.profile,
        ownerReads,
        'Second administrator never requests the private profile',
      );
      const beforeEntryExpiryReads = reads.entry;
      entryValidUntil = new Date(Date.now() + 600).toISOString();
      await returnToApp(page);
      await waitUntil(
        async () =>
          reads.entry >= beforeEntryExpiryReads + 2 &&
          (await workspace
            .getByRole('button', { name: 'Посмотреть профиль', exact: true })
            .count()) === 0,
        'Entry expiry must refresh and remove the cached public action for another administrator',
      );
      entryValidUntil = null;
      await returnToApp(page);
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      await workspace.getByRole('button', { name: 'Кнопка в сообщениях', exact: true }).click();
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), true);
      await page.screenshot({ path: path.join(output, `${width}-${theme}-policy.png`) });
      await nativeBack(page);
      await workspace.getByRole('button', { name: 'Посмотреть профиль', exact: true }).waitFor();
      await nativeBack(page);
      await page.getByRole('button', { name: 'Открыть снова', exact: true }).waitFor();
      const beforeClose = { ...reads };
      await page.waitForTimeout(150);
      assert.deepEqual(reads, beforeClose, 'Closed workspace stops requests');
      assert.deepEqual(errors, []);
      await context.close();
    }
  console.log(`Marketplace states: four browser matrices passed; screenshots: ${output}`);
} finally {
  await browser.close();
  await stopChildProcess(server);
}
