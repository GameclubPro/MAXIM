import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4178/app/');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
  throw new Error('Async settings checks require a local preview server');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on('pageerror', (error) => console.error(error.stack));
page.on('console', (entry) => {
  if (entry.type() === 'error') console.error(entry.text());
});
try {
  await page.goto(new URL('?preview=1&networks=1', base).href);
  await page.locator('.bottom-nav').waitFor();
  await page.evaluate(async () => {
    const moduleUrl = (name) =>
      performance
        .getEntriesByType('resource')
        .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name))?.name;
    const ReactModule = await import(moduleUrl('react.js'));
    const React = ReactModule.default ?? ReactModule;
    const ReactDOM = await import(moduleUrl('react-dom_client.js'));
    const createRoot = ReactDOM.createRoot ?? ReactDOM.default.createRoot;
    const { QueryClient, QueryClientProvider } = await import(
      moduleUrl('@tanstack_react-query.js')
    );
    const { NetworkSettingsMetadataFields } =
      await import('/app/src/features/network-settings/network-settings-metadata-fields.tsx');
    const { FieldMedia } =
      await import('/app/src/features/network-settings/settings-field-controls.tsx');
    const { createNetworkSettingsFieldAdapter } =
      await import('/app/src/features/network-settings/network-settings-field-bindings.ts');
    const { settingsSectionPaths } =
      await import('/app/src/features/network-settings/field-registry.ts');
    const { ReportsSettingsFields } =
      await import('/app/src/pages/settings/reports-settings-fields.tsx');
    const host = document.createElement('div');
    host.id = 'async-settings-fixture';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const h = React.createElement;
    window.__mountAsyncSettings = (kind, options = {}) => {
      window.__pendingMetadata = null;
      window.__pendingMedia = null;
      window.__pendingReportAvailability = null;
      window.__reportAvailabilityRequests = [];
      window.__changes = [];
      const token = crypto.randomUUID();
      const scopeId = crypto.randomUUID();
      const section =
        kind === 'subscription' ? 'requiredSubscription' : kind === 'reports' ? 'reports' : 'links';
      const recipientIds =
        kind === 'reports' ? ['chat-a', 'chat-b', 'chat-c', 'chat-d', 'chat-e'] : ['chat-a'];
      const listPath = 'requiredSubscriptionChannelIds';
      const textPath =
        kind === 'subscription' ? 'requiredSubscriptionBotMessageText' : 'linkBotMessageText';
      const mediaPath = 'botSpeechMedia.linkBotMessageText';
      const contact = {
        userId: 'human-1',
        displayName: 'Анна',
        url: 'https://max.ru/admin',
        sources: ['chat-a'],
      };
      const api = {
        requestKeepalive() {},
        async request(path, init) {
          if (path.endsWith('/reports/availability')) {
            window.__reportAvailabilityRequests.push(path);
            if (options.availability === 'error') throw new Error('Availability unavailable');
            if (options.availability === 'pending')
              return new Promise((resolve, reject) => {
                window.__pendingReportAvailability = (available) =>
                  resolve({ reportsAvailable: available, observedAt: new Date().toISOString() });
                init.signal.addEventListener('abort', () => {
                  window.__reportAvailabilityAborted = true;
                  reject(new DOMException('Scope changed', 'AbortError'));
                });
              });
            return {
              reportsAvailable: options.availability !== 'paused' || !path.includes('/chat-e/'),
              observedAt: new Date().toISOString(),
            };
          }
          const body = JSON.parse(init.body);
          const bound = { requestId: body.requestId, compositionVersion: body.compositionVersion };
          if (path.endsWith('admin-contacts/read'))
            return {
              ...bound,
              sessionId: crypto.randomUUID(),
              items: [contact],
              scannedSources: 1,
              totalSources: 1,
              incompleteSources: [],
              unavailableSources: [],
              complete: true,
              nextCursor: null,
            };
          return new Promise((resolve) => {
            window.__pendingMetadata = () =>
              resolve(
                path.endsWith('required-subscription/resolve')
                  ? {
                      ...bound,
                      channel: {
                        id: 'channel-new',
                        title: 'Новый',
                        entityType: 'channel',
                        link: null,
                        participantsCount: null,
                      },
                    }
                  : { ...bound, contact },
              );
          });
        },
      };
      function Fixture() {
        const [changes, setChanges] = React.useState([]);
        React.useEffect(() => {
          host.dataset.mountToken = token;
        }, []);
        const fields = Object.fromEntries(
          settingsSectionPaths('chat', section).map((path) => [path, { kind: 'mixed' }]),
        );
        fields[listPath] = { kind: 'common', value: ['channel-old'] };
        fields[mediaPath] = { kind: 'common', value: null };
        fields.reportsEnabled =
          options.enabled === 'mixed'
            ? { kind: 'mixed' }
            : { kind: 'common', value: options.enabled === true };
        const adapter = createNetworkSettingsFieldAdapter({
          entityType: 'chat',
          section,
          fields,
          changes,
          errors: {},
          readOnly: false,
          onChanges: setChanges,
          onError() {},
        });
        window.__changes = changes;
        window.__editUnrelated = () => adapter.setScalar(textPath, 'Более поздний текст');
        window.__editContact = () =>
          adapter.setScalar('linkAdminContactButtonUrl', 'https://max.ru/later');
        const read = {
          entityType: 'chat',
          target: { mode: 'selected', entityIds: recipientIds },
          section,
          compositionVersion: 'version-1',
          recipients: recipientIds.map((entityId) => ({ entityId, title: entityId, revision: 1 })),
          fields,
        };
        if (kind === 'media')
          return h(FieldMedia, {
            label: 'Изображение',
            state: adapter.read(mediaPath),
            onChange: (value) => adapter.setScalar(mediaPath, value),
            onClear: () => adapter.clearMedia(mediaPath),
            onRevert: () => adapter.revert(mediaPath),
          });
        return h(NetworkSettingsMetadataFields, {
          api,
          scopeId,
          read,
          fields: adapter,
          onNavigationAllowlist() {},
          children: (context) =>
            kind === 'subscription'
              ? context.requiredSubscriptionSources
              : kind === 'reports'
                ? h(
                    React.Fragment,
                    null,
                    context.runtimeNotes?.reports,
                    h(ReportsSettingsFields, {
                      fields: adapter,
                      activationAvailable: context.reportsActivationAvailable,
                    }),
                  )
                : context.renderAdminContact({
                    enabledPath: 'linkAdminContactButtonEnabled',
                    urlPath: 'linkAdminContactButtonUrl',
                    label: 'Контакт администратора',
                  }),
        });
      }
      const queryClient = new QueryClient();
      root.render(h(QueryClientProvider, { client: queryClient }, h(Fixture, { key: token })));
      return token;
    };
  });
  const fixture = page.locator('#async-settings-fixture');
  const mount = async (kind, options = {}) => {
    const token = await page.evaluate(
      ({ kind, options }) => window.__mountAsyncSettings(kind, options),
      { kind, options },
    );
    await page.waitForFunction(
      (expected) =>
        document.querySelector('#async-settings-fixture')?.dataset.mountToken === expected,
      token,
    );
    await fixture
      .locator(
        kind === 'media'
          ? 'input[type=file]'
          : kind === 'reports'
            ? '.reports-settings'
            : kind === 'subscription'
              ? '.required-subscription__board'
              : '.settings-native-toggle',
      )
      .first()
      .waitFor();
  };
  const startSubscription = async () => {
    await mount('subscription');
    await fixture.getByRole('button', { name: 'Добавить источник', exact: true }).click();
    await fixture.getByLabel('Добавить по ссылке').fill('https://max.ru/new');
    await fixture.getByRole('button', { name: 'Добавить', exact: true }).click();
    await page.waitForFunction(() => window.__pendingMetadata !== null);
  };
  const finishMetadata = async () => {
    await page.evaluate(() => window.__pendingMetadata());
    await fixture
      .getByRole('button', { name: 'Проверяем...', exact: true })
      .waitFor({ state: 'hidden' });
  };
  await startSubscription();
  await page.evaluate(() => window.__editUnrelated());
  await page.waitForFunction(() =>
    window.__changes.some((row) => row.value === 'Более поздний текст'),
  );
  await finishMetadata();
  let changes = await page.evaluate(() => window.__changes);
  assert.ok(
    changes.some(
      (row) =>
        row.path === 'requiredSubscriptionBotMessageText' && row.value === 'Более поздний текст',
    ),
  );
  assert.deepEqual(changes.find((row) => row.path === 'requiredSubscriptionChannelIds')?.value, [
    'channel-old',
    'channel-new',
  ]);
  for (const action of ['clear', 'remove', 'revert']) {
    await startSubscription();
    if (action === 'clear')
      await fixture
        .getByRole('button', { name: 'Очистить обязательные каналы у выбранных', exact: true })
        .click();
    if (action === 'remove')
      await fixture
        .getByRole('button', { name: 'Удалить сохранённый источник 1', exact: true })
        .click();
    if (action === 'revert') {
      await fixture
        .getByRole('button', { name: 'Очистить обязательные каналы у выбранных', exact: true })
        .click();
      await fixture.getByRole('button', { name: 'Отменить изменение списка', exact: true }).click();
    }
    await finishMetadata();
    changes = await page.evaluate(() => window.__changes);
    assert.equal(
      JSON.stringify(changes).includes('channel-new'),
      false,
      `${action} cannot resurrect a delayed source`,
    );
    if (action === 'revert') assert.deepEqual(changes, []);
  }
  const startContact = async () => {
    await mount('contact');
    await fixture.getByRole('button', { name: /^Выбрать администратора:/ }).click();
    await page.locator('.admin-contact-picker').getByRole('button', { name: /Анна/ }).click();
    await page.waitForFunction(() => window.__pendingMetadata !== null);
  };
  await startContact();
  await page.evaluate(() => window.__editUnrelated());
  await page.waitForFunction(() =>
    window.__changes.some((row) => row.value === 'Более поздний текст'),
  );
  await page.evaluate(() => window.__pendingMetadata());
  await page
    .locator('.admin-contact-picker')
    .getByRole('button', { name: 'Закрыть', exact: true })
    .waitFor({ state: 'hidden' });
  changes = await page.evaluate(() => window.__changes);
  assert.ok(
    changes.some((row) => row.path === 'linkBotMessageText' && row.value === 'Более поздний текст'),
  );
  assert.equal(
    changes.find((row) => row.path === 'linkAdminContactButtonUrl')?.value,
    'https://max.ru/admin',
  );
  await startContact();
  await page.evaluate(() => window.__editContact());
  await page.waitForFunction(() =>
    window.__changes.some((row) => row.value === 'https://max.ru/later'),
  );
  await page.evaluate(() => window.__pendingMetadata());
  await page.locator('.admin-contact-picker').getByRole('alert').waitFor();
  assert.equal(
    (await page.evaluate(() => window.__changes)).find(
      (row) => row.path === 'linkAdminContactButtonUrl',
    )?.value,
    'https://max.ru/later',
  );
  const startMedia = async () => {
    await mount('media');
    await page.evaluate(() => {
      File.prototype.arrayBuffer = () =>
        new Promise((resolve) => {
          window.__pendingMedia = () => resolve(new Uint8Array([1, 2, 3]).buffer);
        });
    });
    await fixture
      .locator('input[type=file]')
      .setInputFiles({ name: 'image.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
    await page.waitForFunction(() => window.__pendingMedia !== null);
  };
  await startMedia();
  await page.evaluate(() => window.__editUnrelated());
  await page.waitForFunction(() =>
    window.__changes.some((row) => row.value === 'Более поздний текст'),
  );
  await page.evaluate(() => window.__pendingMedia());
  await fixture.getByText('Изображение добавлено', { exact: true }).waitFor();
  changes = await page.evaluate(() => window.__changes);
  assert.ok(
    changes.some((row) => row.path === 'linkBotMessageText' && row.value === 'Более поздний текст'),
  );
  assert.ok(
    changes.some(
      (row) => row.path === 'botSpeechMedia.linkBotMessageText' && row.value.base64 === 'AQID',
    ),
  );
  for (const action of ['Удалить изображение', 'Отменить изменение изображения']) {
    await startMedia();
    await fixture.getByRole('button', { name: action, exact: true }).click();
    await page.evaluate(() => window.__pendingMedia());
    await page.waitForTimeout(50);
    changes = await page.evaluate(() => window.__changes);
    assert.equal(
      changes.some((row) => row.op === 'set' && row.path === 'botSpeechMedia.linkBotMessageText'),
      false,
      `${action} invalidates pending file`,
    );
  }
  await mount('reports', { availability: 'pending', enabled: false });
  await page.waitForFunction(() => window.__pendingReportAvailability !== null);
  assert.equal(await fixture.getByLabel('Жалобы участников', { exact: true }).isDisabled(), true);
  await mount('contact');
  await page.waitForFunction(() => window.__reportAvailabilityAborted === true);
  assert.deepEqual(await page.evaluate(() => window.__reportAvailabilityRequests), []);

  await mount('reports', { availability: 'paused', enabled: false });
  await fixture
    .getByText('Приём жалоб доступен не во всех чатах сетки.', { exact: true })
    .waitFor();
  assert.equal(await fixture.getByLabel('Жалобы участников', { exact: true }).isDisabled(), true);
  assert.equal((await page.evaluate(() => window.__reportAvailabilityRequests)).length, 5);
  assert.ok(
    (await page.evaluate(() => window.__reportAvailabilityRequests)).at(-1).includes('/chat-e/'),
    'availability checks include recipients beyond the first four-entry settings page',
  );

  for (const enabled of [true, 'mixed']) {
    await mount('reports', { availability: 'paused', enabled });
    await fixture
      .getByText('Приём жалоб доступен не во всех чатах сетки.', { exact: true })
      .waitFor();
    if (enabled === true) await fixture.getByLabel('Жалобы участников', { exact: true }).click();
    else {
      assert.equal(
        await fixture.getByLabel('Жалобы участников', { exact: true }).isDisabled(),
        true,
      );
      await fixture.getByRole('button', { name: 'Выключить во всей сетке', exact: true }).click();
    }
    await page.waitForFunction(() =>
      window.__changes.some((row) => row.path === 'reportsEnabled' && row.value === false),
    );
    const reportsToggle = fixture.getByLabel('Жалобы участников', { exact: true });
    assert.equal(await reportsToggle.isDisabled(), enabled !== true);
    if (enabled === true) {
      await reportsToggle.click();
      await page.waitForFunction(() => window.__changes.length === 0);
      assert.equal(await reportsToggle.isChecked(), true);
    }
  }

  await mount('reports', { availability: 'error', enabled: false });
  await fixture.getByText('Не удалось проверить доступность жалоб.', { exact: true }).waitFor();
  assert.equal(await fixture.getByLabel('Жалобы участников', { exact: true }).isDisabled(), true);
  await mount('reports', { availability: 'available', enabled: false });
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Жалобы участников"]').disabled,
  );
  console.log(
    'PASS delayed metadata/media preserve edits; reports check every recipient and fail closed',
  );
} catch (error) {
  console.error('FIXTURE BODY', await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
