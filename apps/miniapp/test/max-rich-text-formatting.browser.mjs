import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import {
  allocateMiniappBaseUrl,
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';

const base = await allocateMiniappBaseUrl('http://127.0.0.1/app/');
const server = await ensureMiniappDevServer(base);
const screenshots = mkdtempSync(join(tmpdir(), 'maxim-formatting-'));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  for (const [name, width, height, theme, touch] of [
    ['desktop-light', 1280, 900, 'light', false],
    ['desktop-dark', 1280, 900, 'dark', false],
    ['iphone-light', 390, 844, 'light', true],
    ['iphone-dark', 390, 844, 'dark', true],
    ['android-light', 412, 915, 'light', true],
    ['android-dark', 412, 915, 'dark', true],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      hasTouch: touch,
      isMobile: touch,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const editor = page.getByRole('textbox', { name: 'Greeting' });
    const click = async (name) => {
      const button = page.getByRole('button', { name, exact: true });
      if (touch) await button.tap();
      else await button.click();
    };
    const open = async (value = '') => {
      const url = new URL('test/browser/rich-text.html', base);
      url.searchParams.set('composer', '1');
      url.searchParams.set('value', value);
      await page.goto(url.href);
      await editor.waitFor();
      await page.waitForFunction(() => document.querySelector('[contenteditable="true"]'));
      await page.evaluate((theme) => {
        document.documentElement.dataset.maxTheme = theme;
        document.body.dataset.miniappProfile = 'publisher';
      }, theme);
      await click('Форматирование');
    };
    const select = async (start, end = start) => {
      await editor.evaluate(
        (element, [start, end]) => {
          element.focus();
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const nodes = [];
          let node;
          while ((node = walker.nextNode())) nodes.push(node);
          const boundary = (offset) => {
            for (const node of nodes) {
              if (offset <= node.length) return [node, offset];
              offset -= node.length;
            }
            return [element, element.childNodes.length];
          };
          const range = document.createRange();
          range.setStart(...boundary(start));
          range.setEnd(...boundary(end));
          getSelection().removeAllRanges();
          getSelection().addRange(range);
          document.dispatchEvent(new Event('selectionchange'));
        },
        [start, end],
      );
    };
    const markdown = () => page.getByTestId('markdown').textContent();
    const pressed = async (title, active) => {
      await page
        .waitForFunction(
          ([title, active]) =>
            document
              .querySelector(`button[aria-label="${title}"]`)
              ?.getAttribute('aria-pressed') === String(active),
          [title, active],
          { timeout: 2000 },
        )
        .catch(async (error) => {
          console.log({
            title,
            active,
            html: await editor.innerHTML(),
            selection: await page.evaluate(() => ({
              text: getSelection()?.toString(),
              node: getSelection()?.anchorNode?.nodeName,
              bold: document.queryCommandState('bold'),
              focused: document.activeElement?.outerHTML.slice(0, 160),
            })),
          });
          throw error;
        });
    };
    for (const [title, marker] of [
      ['Жирный', '**'],
      ['Курсив', '_'],
      ['Подчеркнутый', '++'],
      ['Зачеркнутый', '~~'],
    ]) {
      await open(`${marker}alpha beta gamma${marker}`);
      await select(6, 10);
      await click(title);
      const command = {
        Жирный: 'bold',
        Курсив: 'italic',
        Подчеркнутый: 'underline',
        Зачеркнутый: 'strikeThrough',
      }[title];
      assert.equal(
        await page.evaluate((command) => document.queryCommandState(command), command),
        false,
        `${name}: selected text actually loses ${title}`,
      );
      assert.equal(
        await markdown(),
        `${marker}alpha ${marker}beta${marker} gamma${marker}`,
        `${name}: remove only selected ${title}`,
      );
      await pressed(title, false);
      const partial = await markdown();
      await open(partial);
      await select(6, 10);
      await pressed(title, false);
      await click(title);
      await pressed(title, true);
      await select(0, 16);
      await click(title);
      assert.equal(await markdown(), 'alpha beta gamma', `${name}: remove entire ${title}`);
      // A collapsed selection changes subsequent typing without inserting placeholder content.
      await open();
      await editor.focus();
      await click(title);
      assert.equal(await markdown(), '');
      await pressed(title, true);
      await page.keyboard.type('marked');
      await click(title);
      await pressed(title, false);
      await page.keyboard.insertText(' plain');
      assert.equal(await markdown(), `${marker}marked${marker} plain`, `${name}: typing toggle`);
      await page.keyboard.press('Control+z');
      assert.equal(await markdown(), `${marker}marked${marker}`, `${name}: undo typing`);
      await page.keyboard.press('Control+Shift+z');
      assert.equal(await markdown(), `${marker}marked${marker} plain`, `${name}: redo typing`);
    }
    await open('**alpha _beta_ gamma** [link](https://max.ru/example)');
    await select(6, 10);
    await click('Жирный');
    assert.equal(await markdown(), '**alpha **_beta_** gamma** [link](https://max.ru/example)');
    await select(0, 21);
    await click('Жирный');
    await pressed('Жирный', true);
    await click('Жирный');
    assert.equal(await markdown(), 'alpha _beta_ gamma [link](https://max.ru/example)');
    await select(6);
    await click('Жирный');
    await page.keyboard.type('new');
    await pressed('Жирный', true);
    assert.equal(await editor.innerText(), 'alpha newbeta gamma link');
    const saved = await markdown();
    await open(saved);
    assert.equal(await editor.innerText(), 'alpha newbeta gamma link');
    assert.equal(await editor.locator('a').getAttribute('href'), 'https://max.ru/example');
    // Native keyboard shortcuts must persist, and links must not masquerade as bold/underline marks.
    await select(20, 24);
    await pressed('Жирный', false);
    await pressed('Подчеркнутый', false);
    await page.keyboard.press('Control+b');
    await pressed('Жирный', true);
    const withBoldLink = await markdown();
    await open(withBoldLink);
    await select(20, 24);
    await pressed('Жирный', true);
    await click('Жирный');
    await pressed('Жирный', false);
    assert.equal(await editor.locator('a').getAttribute('href'), 'https://max.ru/example');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await select(6, 9);
    await pressed('Жирный', true);
    await page.screenshot({ path: join(screenshots, `${name}.png`) });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS ${name}: selection, typing, nested marks, undo/redo, reload, toolbar and layout`,
    );
  }
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await stopChildProcess(server);
}
