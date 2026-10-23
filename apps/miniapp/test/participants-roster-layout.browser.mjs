import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = new URL(process.env.MINIAPP_TEST_BASE_URL ?? 'http://127.0.0.1:4319/app/');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
const output = mkdtempSync(join(tmpdir(), 'maxim-participants-layout-'));
const checkSummary = async (page, context) => {
  const problems = await page
    .locator('.events-dashboard :is(article > small, .events-dashboard__period-label)')
    .evaluateAll((labels) => {
      const issues = [];
      for (const label of labels) {
        const container = label.closest('article, .events-dashboard__head').getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        for (const rect of range.getClientRects()) {
          if (
            rect.left < container.left - 1 ||
            rect.right > container.right + 1 ||
            rect.bottom > container.bottom + 1
          )
            issues.push(`Summary caption outside card: ${label.textContent}`);
        }
      }
      return issues;
    });
  assert.deepEqual(problems, [], `${context}: ${JSON.stringify(problems)}`);
};
const browser = await chromium.launch();
try {
  for (const width of [280, 320, 393]) {
    for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({
        viewport: { width, height: 740 },
        colorScheme: theme,
      });
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(
        context,
        { platform: width === 393 ? 'android' : 'ios' },
        { colorScheme: theme },
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(
        new URL('chat/preview-chat/events?preview=1&section=participants', base).href,
      );
      const rows = page.locator('.participants-roster__item');
      await rows.first().waitFor();
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.locator('.events-dashboard__hero > small').getAttribute('aria-label'),
        'Всего участников',
      );
      await checkSummary(page, `${width}px ${theme}`);

      for (const stress of [false, true]) {
        if (stress) {
          await rows.evaluateAll((items) => {
            const names = ['Александра Александрова', 'Константин Константинов', 'Андрей Фёдоров'];
            for (const [index, row] of items.slice(0, 3).entries()) {
              row.querySelector('.participants-roster__identity strong').textContent = names[index];
              row.querySelector('.participants-roster__identity > span').textContent =
                '@very_long_username_that_must_not_shrink_the_name_column_123456789';
              row.querySelector('.participants-roster__violations > span').textContent = '99+';
            }
          });
        }
        const problems = await rows.evaluateAll((items) => {
          const issues = [];
          for (const row of items) {
            const bounds = row.getBoundingClientRect();
            if (bounds.height < 44) issues.push('Participant row below 44px');
            const name = row.querySelector('.participants-roster__identity strong');
            const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              for (const word of walker.currentNode.textContent.matchAll(/\S+/gu)) {
                const range = document.createRange();
                range.setStart(walker.currentNode, word.index);
                range.setEnd(walker.currentNode, word.index + word[0].length);
                if (range.getClientRects().length > 1) issues.push(`Name word split: ${word[0]}`);
              }
            }
            const content = row
              .querySelector('.participants-roster__content')
              .getBoundingClientRect();
            const count = row.querySelector('.participants-roster__violations');
            const countBounds = count.getBoundingClientRect();
            const arrow = row
              .querySelector('.participants-roster__chevron')
              .getBoundingClientRect();
            if (count.scrollWidth > count.clientWidth + 1) issues.push('Violation count clipped');
            if (arrow.width < 16) issues.push('Participant chevron below 16px');
            if (
              countBounds.left < content.right ||
              arrow.left < countBounds.right ||
              arrow.right > bounds.right
            )
              issues.push('Participant identity, count or chevron overlap');
          }
          if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Page overflow');
          return issues;
        });
        assert.deepEqual(
          problems,
          [],
          `${width}px ${theme} stress=${stress}: ${JSON.stringify(problems)}`,
        );
        await page.screenshot({
          path: join(output, `${width}-${theme}${stress ? '-long-names' : ''}.png`),
          animations: 'disabled',
        });
      }

      await rows.first().click();
      const card = page.locator('.participant-card');
      await card.waitFor();
      await card.locator('.participant-card__loading').waitFor({ state: 'hidden' });
      assert.equal(
        await card.locator('.participant-sheet__identity strong').innerText(),
        'Александра',
      );
      await card.getByRole('button', { name: /Ограничения/ }).click();
      await page.locator('.participant-card-sanctions').waitFor();
      await page
        .locator('.participant-card-sanctions')
        .getByRole('button', { name: 'К участнику', exact: true })
        .click();
      await card.waitFor();
      await card.getByRole('button', { name: 'Закрыть панель', exact: true }).click();
      await card.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.participants-roster').isVisible(), true);

      for (const section of ['participants', 'moderation', 'activity']) {
        await page.goto(
          new URL(
            `chat/preview-chat/events?preview=1&section=${section}&moderationView=history`,
            base,
          ).href,
        );
        await page
          .locator(
            '.events-dashboard :is(.events-dashboard__hero, .events-dashboard__activity-balance) > small',
          )
          .waitFor();
        await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '20px';
          return document.fonts.ready;
        });
        await checkSummary(page, `${width}px ${theme} ${section} 20px text`);
        await page.screenshot({
          path: join(output, `${width}-${theme}-${section}-large-text.png`),
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS participants ${width}px ${theme}: full words, long usernames, 99+, card navigation, summary text zoom`,
      );
      await context.close();
    }
  }
  console.log(`Participant layout screenshots: ${output}`);
} finally {
  await browser.close();
}
