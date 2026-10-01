import assert from 'node:assert/strict';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

export async function runRetentionRegressions(browser, base) {
  for (const scenario of [
    'permissions',
    'pending-close',
    'lost-reply',
    'unconfirmed-read',
    'write-retry',
    'remote-draft',
    'summary',
    'chat-change',
  ]) {
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      colorScheme: 'dark',
    });
    await installMaxBridgeShimInitScript(context, { platform: 'android' }, { colorScheme: 'dark' });
    await context.addInitScript(() => {
      window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
    });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const url = new URL('chat/preview-chat/settings?preview=1&device=android', base);
      await page.goto(url.href);
      await page.getByRole('button', { name: 'Удаление старых сообщений', exact: true }).waitFor();
      await page.evaluate(async (fixtureUrl) => {
        const fixture = await import(fixtureUrl);
        fixture.mountRetentionFixture();
      }, new URL('test/message-retention-fixture.mjs', base).href);
      const entry = page.getByRole('button', { name: 'Удаление старых сообщений', exact: true });
      await entry.click();
      const panel = page.getByRole('dialog', { name: 'Удаление старых сообщений' });
      const toggle = panel.getByRole('switch', { name: 'Удаление по сроку' });
      await toggle.waitFor();
      if (scenario === 'permissions') {
        await page.evaluate(() =>
          window.__RETENTION_TEST__.failWrites({
            status: 409,
            code: 'BOT_CAPABILITY_REQUIRED',
            missingPermissions: ['write'],
            featureKeys: ['messageRetention'],
            message: 'Боту не хватает прав для включения выбранной функции.',
          }),
        );
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        const blocker = page.getByRole('alertdialog', { name: 'Боту не хватает прав' });
        await blocker.waitFor();
        assert.equal(
          await panel.getByText('Настройки изменены в другом сеансе', { exact: true }).count(),
          0,
        );
        assert.equal(
          await page.evaluate(() => window.__RETENTION_TEST__.serverState().enabled),
          false,
        );
        await page.evaluate(() => window.__RETENTION_TEST__.failWrites(null));
        await blocker.getByRole('button', { name: 'Проверить снова', exact: true }).click();
        await panel.getByText('Сохранено', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => window.__RETENTION_TEST__.serverState().enabled),
          true,
        );
      }
      if (scenario === 'pending-close') {
        await page.evaluate(() => window.__RETENTION_TEST__.holdWrite());
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.getByRole('button', { name: 'Сохраняем', exact: true }).waitFor();
        assert.equal(
          await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
          true,
        );
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.__MAXIM_VISUAL_BRIDGE_PRESS_BACK__());
        await page.locator('.settings-drilldown__backdrop').click({ force: true });
        assert.equal(
          await page.getByRole('dialog', { name: 'Не сохранять изменения?' }).count(),
          0,
        );
        assert.equal(await panel.isVisible(), true);
        assert.equal(
          await panel.getByRole('button', { name: 'Сохраняем', exact: true }).count(),
          1,
        );
        await page.evaluate(() => window.__RETENTION_TEST__.releaseWrite());
        await panel.getByText('Сохранено', { exact: true }).waitFor();
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
      }
      if (scenario === 'lost-reply' || scenario === 'unconfirmed-read') {
        await page.evaluate((failRead) => {
          window.__RETENTION_TEST__.loseNextReply();
          window.__RETENTION_TEST__.failReads(failRead);
        }, scenario === 'unconfirmed-read');
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        if (scenario === 'unconfirmed-read') {
          await panel.getByText('Сохранение пока не подтверждено', { exact: true }).waitFor();
          assert.equal(
            await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
            true,
          );
          await page.keyboard.press('Escape');
          assert.equal(
            await page.getByRole('dialog', { name: 'Не сохранять изменения?' }).count(),
            0,
          );
          await page.evaluate(() => window.__RETENTION_TEST__.failReads(false));
          await panel.getByRole('button', { name: 'Проверить сохранение', exact: true }).click();
        }
        await panel.getByText('Сохранено', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(
            () => window.__RETENTION_TEST__.requests.filter((method) => method === 'PUT').length,
          ),
          1,
        );
        assert.equal(
          await panel.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
          true,
        );
        assert.equal(
          await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
          false,
        );
      }
      if (scenario === 'write-retry') {
        await page.evaluate(() =>
          window.__RETENTION_TEST__.failWrites({
            status: 400,
            code: 'TEST_REJECTION',
            message: 'Запись отклонена.',
          }),
        );
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.getByText('Не удалось сохранить изменения', { exact: true }).waitFor();
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        assert.equal(
          await panel.getByText('Не удалось сохранить изменения', { exact: true }).count(),
          1,
        );
        assert.equal(await toggle.isChecked(), true);
        await page.evaluate(() => window.__RETENTION_TEST__.failWrites(null));
        await panel.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
        await panel.getByText('Сохранено', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(
            () => window.__RETENTION_TEST__.requests.filter((method) => method === 'PUT').length,
          ),
          2,
        );
      }
      if (scenario === 'remote-draft') {
        await toggle.check();
        await panel.getByRole('radio', { name: '24 часа', exact: true }).check();
        await page.evaluate(() =>
          window.__RETENTION_TEST__.replaceServer({
            enabled: true,
            hours: 24,
            revision: 1,
            status: 'running',
          }),
        );
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        await page.waitForFunction(
          () => document.querySelector('.message-retention-footer > span')?.textContent === '',
        );
        await page.evaluate(() =>
          window.__RETENTION_TEST__.replaceServer({ hours: 48, revision: 2 }),
        );
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        await page.waitForFunction(
          () =>
            document.querySelector('[data-segmented-value="48"]')?.getAttribute('aria-checked') ===
            'true',
        );
        assert.equal(
          await panel.getByText('Настройки изменены в другом сеансе', { exact: true }).count(),
          0,
        );
        assert.equal(
          await panel.getByRole('button', { name: 'Сохранить', exact: true }).isDisabled(),
          true,
        );
      }
      if (scenario === 'summary') {
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await page.evaluate(() => {
          window.__RETENTION_TEST__.replaceServer({ status: 'unavailable' });
          window.__RETENTION_TEST__.publishSummary({ status: 'unavailable' });
        });
        await page.waitForFunction(
          () =>
            document.getElementById('settings-message-retention-entry-status')?.textContent ===
            'Недоступно',
        );
        assert.equal(
          await page.evaluate(
            () => window.__RETENTION_TEST__.requests.filter((method) => method === 'GET').length,
          ),
          1,
        );
        await entry.click();
        await panel.getByText('Отключено оператором', { exact: true }).waitFor();
        assert.equal(
          await page.locator('#settings-message-retention-entry-status').textContent(),
          'Недоступно',
        );
      }
      if (scenario === 'chat-change') {
        await toggle.check();
        await panel.getByRole('radio', { name: '24 часа', exact: true }).check();
        await page.evaluate(() => window.__RETENTION_TEST__.changeChat('other-chat'));
        await panel.waitFor({ state: 'hidden' });
        await entry.click();
        await toggle.waitFor();
        assert.equal(await toggle.isChecked(), false);
        assert.equal(
          await panel.getByRole('radio', { name: '48 часов', exact: true }).isChecked(),
          true,
        );
      }
      assert.deepEqual(errors, [], scenario);
    } finally {
      await context.close();
    }
  }
}
