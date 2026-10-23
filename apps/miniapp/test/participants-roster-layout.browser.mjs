import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';
import {
  installNativeVisualModeInitScript,
  applyNativeVisualMode,
} from '../../../scripts/miniapp-native-visual-mode.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

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
const checkRosterControls = async (page, context) => {
  const problems = await page.locator('.participants-roster').evaluate((roster) => {
    const issues = [];
    const canvas = document.createElement('canvas').getContext('2d');
    const textWidth = (text, style) => {
      // WebKit can leave the computed font shorthand empty on native form controls.
      canvas.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      return (
        canvas.measureText(text).width +
        Math.max(0, Array.from(text).length - 1) * (Number.parseFloat(style.letterSpacing) || 0)
      );
    };
    const contentWidth = (node, style) =>
      node.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight);
    const controls = Array.from(
      roster.querySelectorAll(
        '.participants-roster__toolbar :is(input, button, summary), .participants-roster__filters select',
      ),
    ).filter((control) => {
      const closedDetails = control.closest('details:not([open])');
      return (
        control.getClientRects().length > 0 &&
        (!closedDetails || control === closedDetails.querySelector(':scope > summary'))
      );
    });
    if (controls.length < 4) issues.push('Participant search, filters or toolbar controls missing');
    for (const control of controls) {
      const bounds = control.getBoundingClientRect();
      const name = control.getAttribute('aria-label') ?? control.tagName;
      if (bounds.width < 43.5 || bounds.height < 43.5)
        issues.push(
          `${name}: touch target ${bounds.width.toFixed(1)}×${bounds.height.toFixed(1)}px`,
        );
      if (bounds.left < -1 || bounds.right > innerWidth + 1)
        issues.push(`${name}: control exceeds viewport`);
    }
    for (const [index, control] of controls.entries()) {
      const bounds = control.getBoundingClientRect();
      for (const other of controls.slice(index + 1)) {
        const otherBounds = other.getBoundingClientRect();
        if (
          Math.min(bounds.right, otherBounds.right) - Math.max(bounds.left, otherBounds.left) > 1 &&
          Math.min(bounds.bottom, otherBounds.bottom) - Math.max(bounds.top, otherBounds.top) > 1
        )
          issues.push(
            `${control.getAttribute('aria-label')} overlaps ${other.getAttribute('aria-label')}`,
          );
      }
    }
    const search = roster.querySelector('.participants-roster__search input');
    if (!search?.placeholder) issues.push('Participant search placeholder missing');
    else {
      const style = getComputedStyle(search);
      const placeholderStyle = getComputedStyle(search, '::placeholder');
      const width = textWidth(search.placeholder, placeholderStyle);
      const available = contentWidth(search, style);
      if (width > available + 1)
        issues.push(
          `Search placeholder clipped: "${search.placeholder}" needs ${width.toFixed(1)}px, has ${available.toFixed(1)}px`,
        );
    }
    const selects = roster.querySelectorAll('.participants-roster__filters select');
    if (selects.length !== 2)
      issues.push(`Expected both participant filters, found ${selects.length}`);
    for (const select of selects) {
      const style = getComputedStyle(select);
      // Native indicators consume space beyond CSS padding. Custom indicators live in that padding.
      const nativeIndicator =
        style.appearance === 'none' || style.webkitAppearance === 'none' ? 0 : 24;
      const available = contentWidth(select, style) - nativeIndicator;
      const originalValue = select.value;
      try {
        for (const option of select.options) {
          // Exercise every selected label without triggering filtering requests or React state changes.
          select.value = option.value;
          const text = select.selectedOptions[0].label;
          const width = textWidth(text, style);
          if (width > available + 1)
            issues.push(
              `${select.getAttribute('aria-label')}: "${text}" needs ${width.toFixed(1)}px, has ${available.toFixed(1)}px`,
            );
        }
      } finally {
        select.value = originalValue;
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) issues.push('Page overflow');
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
      await checkRosterControls(page, `Chromium ${width}px ${theme}`);

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
        if (section === 'participants')
          await checkRosterControls(page, `Chromium ${width}px ${theme} 20px text`);
        await page.screenshot({
          path: join(output, `${width}-${theme}-${section}-large-text.png`),
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS participants ${width}px ${theme}: all filter labels, search placeholder, 44px controls, full words, long usernames, 99+, card navigation, text zoom`,
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const narrowBrowser = await webkit.launch(captureBrowserLaunchOptions('webkit', base.href));
try {
  for (const theme of ['light', 'dark']) {
    const context = await narrowBrowser.newContext({
      viewport: { width: 280, height: 603 },
      screen: { width: 280, height: 667 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['iPhone SE'].userAgent,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      colorScheme: theme,
    });
    try {
      await installNativeVisualModeInitScript(context);
      await installMaxBridgeShimInitScript(context, { platform: 'ios' }, { colorScheme: theme });
      await context.route(/https:\/\/st\.max\.ru\/js\/max-web-app\.js(?:\?.*)?$/u, (route) =>
        route.fulfill({
          contentType: 'application/javascript',
          body: '/* Visual MAX Bridge shim. */',
        }),
      );
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-07-18T09:00:00.000Z'));
      await page.goto(
        new URL('chat/preview-chat/events?preview=1&section=participants&device=iphone-se', base)
          .href,
      );
      await page.locator('.participants-roster__list[aria-busy="false"]').waitFor();
      await applyNativeVisualMode(page, { safeTop: 20, safeBottom: 12 });
      await page.evaluate(() => document.fonts.ready);
      for (const largeText of [false, true]) {
        if (largeText)
          await page.evaluate(() => {
            document.documentElement.style.fontSize = '20px';
            return document.fonts.ready;
          });
        const label = `WebKit 280px ${theme}${largeText ? ' 20px text' : ''}`;
        await checkRosterControls(page, label);
        await checkSummary(page, label);
        await page.screenshot({
          path: join(output, `webkit-280-${theme}${largeText ? '-large-text' : ''}.png`),
          animations: 'disabled',
        });
      }
      assert.deepEqual(errors, []);
      console.log(
        `PASS WebKit participants 280px ${theme}: all filter labels, search placeholder, 44px controls, text zoom`,
      );
    } finally {
      await context.close();
    }
  }
} finally {
  await narrowBrowser.close();
}
console.log(`Participant layout screenshots: ${output}`);
