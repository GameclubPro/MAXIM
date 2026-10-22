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
    const { NetworkSettingsMetadataFields } =
      await import('/app/src/features/network-settings/network-settings-metadata-fields.tsx');
    const { FieldMedia } =
      await import('/app/src/features/network-settings/settings-field-controls.tsx');
    const { createNetworkSettingsFieldAdapter } =
      await import('/app/src/features/network-settings/network-settings-field-bindings.ts');
    const { settingsSectionPaths } =
      await import('/app/src/features/network-settings/field-registry.ts');
    const host = document.createElement('div');
    host.id = 'async-settings-fixture';
    document.body.replaceChildren(host);
    const root = createRoot(host);
    const h = React.createElement;
    window.__mountAsyncSettings = (kind) => {
      window.__pendingMetadata = null;
      window.__pendingMedia = null;
      window.__changes = [];
      const token = crypto.randomUUID();
      const scopeId = crypto.randomUUID();
      const section = kind === 'subscription' ? 'requiredSubscription' : 'links';
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
          target: { mode: 'selected', entityIds: ['chat-a'] },
          section,
          compositionVersion: 'version-1',
          recipients: [{ entityId: 'chat-a', title: 'Чат', revision: 1 }],
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
              : context.renderAdminContact({
                  enabledPath: 'linkAdminContactButtonEnabled',
                  urlPath: 'linkAdminContactButtonUrl',
                  label: 'Контакт администратора',
                }),
        });
      }
      root.render(h(Fixture, { key: token }));
      return token;
    };
  });
  const fixture = page.locator('#async-settings-fixture');
  const mount = async (kind) => {
    const token = await page.evaluate((value) => window.__mountAsyncSettings(value), kind);
    await page.waitForFunction(
      (expected) =>
        document.querySelector('#async-settings-fixture')?.dataset.mountToken === expected,
      token,
    );
    await fixture
      .locator(kind === 'media' ? 'input[type=file]' : 'section')
      .first()
      .waitFor();
  };
  const startSubscription = async () => {
    await mount('subscription');
    await fixture.getByLabel('Ссылка или ID чата/канала').fill('https://max.ru/new');
    await fixture.getByRole('button', { name: 'Проверить и добавить', exact: true }).click();
    await page.waitForFunction(() => window.__pendingMetadata !== null);
  };
  const finishMetadata = async () => {
    await page.evaluate(() => window.__pendingMetadata());
    await fixture.getByText('Проверяем канал…', { exact: true }).waitFor({ state: 'hidden' });
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
      await fixture.getByRole('button', { name: 'Убрать из общего списка', exact: true }).click();
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
    await fixture
      .getByRole('button', { name: 'Выбрать администратора сетки', exact: true })
      .click();
    await fixture.getByRole('button', { name: 'Выбрать · Чат', exact: true }).click();
    await page.waitForFunction(() => window.__pendingMetadata !== null);
  };
  await startContact();
  await page.evaluate(() => window.__editUnrelated());
  await page.waitForFunction(() =>
    window.__changes.some((row) => row.value === 'Более поздний текст'),
  );
  await page.evaluate(() => window.__pendingMetadata());
  await fixture
    .getByRole('button', { name: 'Закрыть выбор', exact: true })
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
  await fixture.getByRole('alert').waitFor();
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
  console.log(
    'PASS delayed subscription/contact/media preserve later fields and respect clear/remove/revert',
  );
} catch (error) {
  console.error('FIXTURE BODY', await page.locator('body').innerText());
  throw error;
} finally {
  await browser.close();
}
