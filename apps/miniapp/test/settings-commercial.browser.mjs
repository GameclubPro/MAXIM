import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import presets from '../src/lib/preview-device-presets.json' with { type: 'json' };
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import {
  captureBrowserLaunchOptions,
  resolveCaptureDevice,
  setPhoneKeyboard,
  settleVisualFrame,
} from '../../../scripts/miniapp-smartphone.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import {
  applyNativeVisualMode,
  installNativeVisualModeInitScript,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { clickSettingsOverviewEntry } from './settings-overview-browser-helpers.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-commercial-screen-'));
try {
  for (const device of ['iphone-se', 'iphone', 'android']) {
    const capture = resolveCaptureDevice(presets[device]);
    const browser = await { chromium, webkit }[capture.browserName].launch(
      captureBrowserLaunchOptions(capture.browserName, base),
    );
    try {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({
          ...capture.contextOptions,
          colorScheme: theme,
          locale: 'ru-RU',
          timezoneId: 'Europe/Moscow',
        });
        await installNativeVisualModeInitScript(context);
        await installMaxBridgeShimInitScript(context, capture.profile, { colorScheme: theme });
        await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
          route.fulfill({ contentType: 'text/javascript', body: '/* Local bridge */' }),
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${base}chat/preview-chat/settings?preview=1&device=${device}`);
        await applyNativeVisualMode(page, capture.profile);
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        const panel = page.locator('.settings-drilldown__panel--commercial');
        await panel.locator('.commercial-studio').waitFor();
        await settleVisualFrame(page);
        assert.equal(
          await panel.getByRole('button', { name: 'Сохранить', exact: true }).count(),
          0,
          'Opening must not change saved thresholds',
        );
        assert.equal(await panel.locator('details').getAttribute('open'), null);
        assert.match(
          await panel.locator('.commercial-studio__ai').innerText(),
          /без автоматических удалений/u,
        );
        await page.screenshot({ path: join(screenshots, `${device}-${theme}.png`) });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        assert.deepEqual(
          await panel
            .locator(
              '.commercial-studio button, .commercial-studio__ai > div, .settings-native-toggle__title',
            )
            .evaluateAll((nodes) =>
              nodes
                .filter(
                  (node) => node.getClientRects().length && node.scrollWidth > node.clientWidth + 2,
                )
                .map((node) => node.textContent),
            ),
          [],
          `${device}/${theme}: clipped control`,
        );
        await panel.getByRole('button', { name: 'Строго', exact: true }).click();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel
          .getByRole('button', { name: 'Сохранить', exact: true })
          .waitFor({ state: 'hidden' });
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(
          await panel
            .getByRole('button', { name: 'Строго', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        await panel.getByText('Повторные нарушения', { exact: true }).click();
        await panel
          .getByRole('button', {
            name: 'Редактировать текст предупреждения об удалении рекламы',
            exact: true,
          })
          .click();
        const editor = page.locator('.bot-message-editor-sheet__panel').getByRole('textbox');
        await editor.fill('Пожалуйста, не размещайте рекламу.');
        await setPhoneKeyboard(page, { height: 220, open: true });
        await settleVisualFrame(page);
        const sheet = page.locator('.bot-message-editor-sheet__panel');
        const bounds = await sheet.boundingBox();
        const viewport = await page.evaluate(() => ({
          height: visualViewport.height,
          offset: visualViewport.offsetTop,
        }));
        assert.ok(
          bounds.y >= viewport.offset - 2 &&
            bounds.y + bounds.height <= viewport.offset + viewport.height + 2,
          `${device}: editor must fit visible viewport`,
        );
        await page.screenshot({ path: join(screenshots, `${device}-${theme}-keyboard.png`) });
        await setPhoneKeyboard(page, { open: false });
        await sheet
          .getByRole('button', { name: /Готово|Закрыть/u })
          .last()
          .click();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel
          .getByRole('button', { name: 'Сохранить', exact: true })
          .waitFor({ state: 'hidden' });
        await panel.waitFor({ state: 'hidden' });
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        await panel.getByRole('button', { name: 'Мягко', exact: true }).click();
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await clickSettingsOverviewEntry(page, 'Коммерческая реклама');
        assert.equal(
          await panel
            .getByRole('button', { name: 'Строго', exact: true })
            .getAttribute('aria-pressed'),
          'true',
          'Discard restores saved profile',
        );
        await panel
          .getByRole('checkbox', { name: 'Фильтровать коммерческую рекламу', exact: true })
          .uncheck();
        assert.equal(
          await panel
            .getByRole('group', { name: 'Чувствительность коммерческого фильтра' })
            .count(),
          0,
        );
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel
          .getByRole('button', { name: 'Сохранить', exact: true })
          .waitFor({ state: 'hidden' });
        assert.deepEqual(errors, []);
        await context.close();
        console.log(
          `PASS ${device}/${theme}: unchanged open, save, speech keyboard, discard, disable, layout`,
        );
      }
    } finally {
      await browser.close();
    }
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}?preview=1`);
    await page.locator('.bottom-nav').waitFor();
    await page.evaluate(async () => {
      const moduleUrl = (name) =>
        performance
          .getEntriesByType('resource')
          .findLast((entry) => new URL(entry.name).pathname.endsWith('/' + name))?.name;
      const ReactModule = await import(moduleUrl('react.js'));
      const React = ReactModule.default ?? ReactModule;
      const ReactDOM = await import(moduleUrl('react-dom_client.js'));
      const { SharedCommercialSettingsFields } =
        await import('/app/src/pages/settings/shared-commercial-settings-fields.tsx');
      const { createNetworkSettingsFieldAdapter } =
        await import('/app/src/features/network-settings/network-settings-field-bindings.ts');
      const { settingsSectionPaths } =
        await import('/app/src/features/network-settings/field-registry.ts');
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const root = (ReactDOM.createRoot ?? ReactDOM.default.createRoot)(host);
      window.__commercialMount = (mode) => {
        window.__commercialChanges = [];
        function Fixture() {
          const [changes, setChanges] = React.useState([]);
          const fields = Object.fromEntries(
            settingsSectionPaths('chat', 'commercialFilter').map((path) => [
              path,
              { kind: mode === 'loading' ? 'loading' : 'mixed' },
            ]),
          );
          if (mode !== 'loading')
            fields.commercialAdsFilterEnabled = { kind: 'common', value: true };
          if (mode === 'custom' || mode === 'readonly')
            Object.assign(
              fields,
              Object.fromEntries(
                Object.entries({
                  commercialAdsSensitivity: 'BALANCED',
                  commercialAdsWarnThreshold: 60,
                  commercialAdsDeleteThreshold: 61,
                  textFiltersWarnEnabled: false,
                  textFiltersMuteEnabled: false,
                  textFiltersBanEnabled: true,
                  textFiltersBotMessageEnabled: false,
                }).map(([path, value]) => [path, { kind: 'common', value }]),
              ),
            );
          const adapter = createNetworkSettingsFieldAdapter({
            entityType: 'chat',
            section: 'commercialFilter',
            fields,
            changes,
            errors: {},
            readOnly: mode === 'readonly',
            onChanges: setChanges,
            onError() {},
          });
          window.__commercialChanges = changes;
          return React.createElement(SharedCommercialSettingsFields, {
            fields: adapter,
            actions: null,
          });
        }
        root.render(React.createElement(Fixture, { key: mode }));
      };
    });
    for (const mode of ['custom', 'mixed', 'readonly', 'loading']) {
      await page.evaluate((mode) => window.__commercialMount(mode), mode);
      await page.getByRole('button', { name: 'Мягко', exact: true }).waitFor();
      await settleVisualFrame(page);
      assert.deepEqual(await page.evaluate(() => window.__commercialChanges), []);
      assert.equal(
        await page.locator('.commercial-studio__profiles [aria-pressed="true"]').count(),
        0,
      );
      if (mode === 'readonly' || mode === 'loading') {
        assert.equal(
          await page.getByRole('button', { name: 'Строго', exact: true }).isDisabled(),
          true,
        );
        assert.equal(await page.getByRole('checkbox').isDisabled(), true);
      } else {
        if (mode === 'custom') {
          await page.getByText('Повторные нарушения', { exact: true }).click();
          assert.match(
            await page.locator('.commercial-studio__ladder li').nth(2).innerText(),
            /Блокировка/u,
            'Third strike ban when mute is disabled',
          );
        }
        await page.getByRole('button', { name: 'Баланс', exact: true }).click();
        assert.deepEqual(
          await page.evaluate(() =>
            Object.fromEntries(
              window.__commercialChanges.map((change) => [change.path, change.value]),
            ),
          ),
          {
            ...(mode === 'mixed' ? { commercialAdsSensitivity: 'BALANCED' } : {}),
            commercialAdsWarnThreshold: 45,
            commercialAdsDeleteThreshold: 65,
          },
        );
      }
    }
    console.log(
      'PASS custom and mixed profiles stay untouched; explicit profile writes only its bundle; read-only/loading disabled; actual sanction ladder',
    );
  } finally {
    await browser.close();
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await stopChildProcess(server);
}
