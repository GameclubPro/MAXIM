import assert from 'node:assert/strict';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

export async function runRetentionRegressions(browser, base) {
  for (const scenario of [
    'permissions',
    'pending-close',
    'lost-reply',
    'unconfirmed-read',
    'late-commit',
    'uncertain-conflict',
    'uncertain-conflict-read-error',
    'write-retry',
    'remote-draft',
    'summary',
    'chat-change',
    'connect-bot',
    'connection-rights',
    'mixed-hours',
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
      await page.evaluate(
        async ({ fixtureUrl, mixed }) => {
          const fixture = await import(fixtureUrl);
          if (mixed) fixture.mountMixedRetentionFixture();
          else fixture.mountRetentionFixture();
        },
        {
          fixtureUrl: new URL('test/message-retention-fixture.mjs', base).href,
          mixed: scenario === 'mixed-hours',
        },
      );
      if (scenario === 'mixed-hours') {
        const group = page.getByRole('radiogroup', { name: 'Удалять сообщения старше' });
        const first = group.getByRole('radio', { name: '24 часа', exact: true });
        await first.waitFor();
        assert.equal(await first.getAttribute('tabindex'), '0');
        const mixedToggle = page.getByRole('checkbox', { name: 'Удаление по сроку' });
        assert.equal(await mixedToggle.getAttribute('aria-checked'), 'mixed');
        assert.equal(await mixedToggle.evaluate((node) => node.indeterminate), true);
        assert.equal(
          await page
            .getByText(
              'Добавьте «Ластика» администратором в чаты сетки с правами чтения и удаления сообщений.',
              { exact: true },
            )
            .isVisible(),
          true,
        );
        assert.equal(await page.getByText('«Ластик» подключён', { exact: true }).count(), 0);
        await mixedToggle.focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await page
            .locator('.message-retention-help > summary')
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press('Tab');
        assert.equal(await first.evaluate((node) => node === document.activeElement), true);
        await page.keyboard.press('ArrowRight');
        assert.equal(await group.getByRole('radio', { name: '48 часов' }).isChecked(), true);
        await page.keyboard.press('End');
        assert.equal(await group.getByRole('radio', { name: '1 неделя' }).isChecked(), true);
        await mixedToggle.click();
        assert.equal(
          await page.getByRole('switch', { name: 'Удаление по сроку' }).isChecked(),
          true,
        );
        assert.deepEqual(errors, [], scenario);
        continue;
      }
      const entry = page.getByRole('button', { name: 'Удаление старых сообщений', exact: true });
      await entry.click();
      const panel = page.getByRole('dialog', { name: 'Удаление старых сообщений' });
      const toggle = panel.getByRole('switch', { name: 'Удаление по сроку' });
      await toggle.waitFor();
      if (scenario === 'connect-bot') {
        await page.evaluate(() =>
          window.__RETENTION_TEST__.replaceServer({ connectionStatus: 'missing' }),
        );
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        await panel
          .getByText('Добавьте бота в чат администратором с правами чтения и удаления сообщений.', {
            exact: true,
          })
          .waitFor();
        const link = panel.getByRole('link', { name: 'Открыть бота «Ластик»', exact: true });
        assert.equal(await link.getAttribute('href'), 'https://max.ru/id613000037577_5_bot');
        await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
        assert.equal(
          await panel.evaluate((node) => node.scrollWidth > node.clientWidth + 2),
          false,
        );
        await link.scrollIntoViewIfNeeded();
        assert.equal(
          await link.evaluate((node) => node.getBoundingClientRect().height >= 44),
          true,
        );
      }
      if (scenario === 'connection-rights') {
        await page.evaluate(() =>
          window.__RETENTION_TEST__.replaceServer({ connectionStatus: 'no_access' }),
        );
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        await panel
          .getByText('Назначьте бота администратором с правами чтения и удаления сообщений.', {
            exact: true,
          })
          .waitFor();
        assert.equal(
          await panel
            .getByRole('link', { name: 'Открыть бота «Ластик»', exact: true })
            .getAttribute('href'),
          'https://max.ru/id613000037577_5_bot',
        );
        assert.equal(await panel.getByText('«Ластик» подключён', { exact: true }).count(), 0);
      }
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
      if (scenario === 'late-commit') {
        await page.evaluate(() => {
          window.__RETENTION_TEST__.holdWrite();
          window.__RETENTION_TEST__.loseNextReplyBeforeCommit();
        });
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.getByText('Сохранение пока не подтверждено', { exact: true }).waitFor();
        assert.deepEqual(
          await page.evaluate(() => ({
            enabled: window.__RETENTION_TEST__.serverState().enabled,
            revision: window.__RETENTION_TEST__.serverState().revision,
          })),
          { enabled: false, revision: 0 },
        );
        assert.equal(await toggle.isDisabled(), true);
        assert.equal(await panel.getByRole('radio', { name: '24 часа' }).isDisabled(), true);
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
        await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
        assert.equal(
          await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
          true,
        );
        await panel.getByRole('button', { name: 'Проверить сохранение', exact: true }).click();
        await page.waitForFunction(() => window.__RETENTION_TEST__.writes.length === 2);
        assert.equal(
          await page.evaluate(() => {
            const writes = window.__RETENTION_TEST__.writes;
            return (
              Boolean(writes[0].operationId) &&
              JSON.stringify(writes[0]) === JSON.stringify(writes[1])
            );
          }),
          true,
        );
        assert.equal(
          await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
          true,
        );
        await page.evaluate(() => window.__RETENTION_TEST__.releaseWrite());
        await panel.getByText('Сохранено', { exact: true }).waitFor();
        assert.equal(
          await page.evaluate(() => window.__RETENTION_TEST__.serverState().revision),
          1,
        );
        assert.equal(
          await page.evaluate(() => window.__RETENTION_TEST__.serverState().enabled),
          true,
        );
        assert.equal(
          await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
          false,
        );
      }
      if (scenario === 'uncertain-conflict' || scenario === 'uncertain-conflict-read-error') {
        await page.evaluate(() => {
          window.__RETENTION_TEST__.holdWrite();
          window.__RETENTION_TEST__.loseNextReplyBeforeCommit();
        });
        await toggle.check();
        await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
        await panel.getByText('Сохранение пока не подтверждено', { exact: true }).waitFor();
        await page.evaluate(() => {
          // A different administrator wins while the original request is still in flight.
          window.__RETENTION_TEST__.replaceServer({
            revision: 1,
            enabled: false,
            hours: 168,
            status: 'off',
            lastOperationId: '84823d3a-8866-4b58-9d43-179da0e6595a',
          });
          window.__RETENTION_TEST__.releaseWrite();
        });
        if (scenario === 'uncertain-conflict-read-error')
          await page.evaluate(() => window.__RETENTION_TEST__.failReads(true));
        await panel.getByRole('button', { name: 'Проверить сохранение', exact: true }).click();
        await panel.getByText('Настройки изменены в другом сеансе', { exact: true }).waitFor();
        if (scenario === 'uncertain-conflict-read-error') {
          await panel.getByText('Сохранение пока не подтверждено', { exact: true }).waitFor();
          assert.equal(
            await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).isDisabled(),
            true,
          );
          assert.equal(
            await panel
              .getByRole('button', { name: 'Принять настройки', exact: true })
              .isDisabled(),
            true,
          );
          const retry = panel.getByRole('button', { name: 'Проверить сохранение', exact: true });
          assert.equal(await retry.isVisible(), true);
          assert.equal(await retry.isDisabled(), false);
          await page.evaluate(() => window.__RETENTION_TEST__.failReads(false));
          await retry.click();
        }
        await page.waitForFunction(
          () =>
            !document.querySelector('.settings-drilldown__close[aria-label="Закрыть панель"]')
              ?.disabled,
        );
        assert.equal(await toggle.isDisabled(), false);
        assert.equal(await panel.getByText('Сохранено', { exact: true }).count(), 0);
        assert.equal(
          await page.evaluate(() => window.__RETENTION_TEST__.serverState().revision),
          1,
        );
        assert.equal(
          await page.evaluate(
            (expectedCount) => {
              const writes = window.__RETENTION_TEST__.writes;
              return (
                writes.length === expectedCount &&
                writes.every((input) => JSON.stringify(input) === JSON.stringify(writes[0]))
              );
            },
            scenario === 'uncertain-conflict-read-error' ? 3 : 2,
          ),
          true,
        );
        await panel.getByRole('button', { name: 'Принять настройки', exact: true }).click();
        assert.equal(await toggle.isChecked(), false);
        assert.equal(await panel.getByRole('radio', { name: '1 неделя' }).isChecked(), true);
        await panel.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
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
        // The overview contains only the module name; connection/status belongs inside the panel.
        await panel.waitFor({ state: 'hidden' });
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        assert.equal(await entry.innerText(), 'Удаление старых сообщений');
        assert.equal(await entry.locator('.settings-section__status-chip').count(), 0);
        assert.equal(
          await page.evaluate(
            () => window.__RETENTION_TEST__.requests.filter((method) => method === 'GET').length,
          ),
          1,
        );
        await entry.click();
        await panel.getByText('Временно недоступно', { exact: true }).waitFor();
        assert.equal(await page.locator('#settings-message-retention-entry-status').count(), 0);
        assert.equal(await entry.innerText(), 'Удаление старых сообщений');
        assert.equal(
          await panel.getByRole('switch', { name: 'Удаление по сроку' }).isDisabled(),
          true,
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
