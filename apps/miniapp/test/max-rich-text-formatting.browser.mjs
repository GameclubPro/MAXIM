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
    const applyLink = async (href) => {
      await click('Ссылка');
      await page.getByRole('textbox', { name: 'Адрес ссылки' }).fill(href);
      await click('Применить');
    };
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
    await open();
    await editor.focus();
    await applyLink('https://example.com/article?source=publik&read=1');
    await page.keyboard.type('Read more');
    assert.equal(
      await markdown(),
      '[Read more](https://example.com/article?source=publik&read=1)',
      `${name}: replacing the selected link placeholder retains its destination`,
    );
    await select(0, 9);
    await page.keyboard.insertText('Подробнее 🔗');
    assert.equal(
      await markdown(),
      '[Подробнее 🔗](https://example.com/article?source=publik&read=1)',
    );
    await page.keyboard.press('Control+z');
    assert.equal(await markdown(), '[Read more](https://example.com/article?source=publik&read=1)');
    await page.keyboard.press('Control+Shift+z');
    assert.equal(
      await markdown(),
      '[Подробнее 🔗](https://example.com/article?source=publik&read=1)',
    );
    await page.keyboard.type('!');
    assert.equal(
      await markdown(),
      '[Подробнее 🔗!](https://example.com/article?source=publik&read=1)',
    );
    await editor.blur();
    assert.equal(await editor.locator('[data-max-link-boundary]').count(), 0);
    assert.equal(await editor.innerText(), 'Подробнее 🔗!');
    await open(await markdown());
    assert.equal(await editor.locator('a').textContent(), 'Подробнее 🔗!');
    await select(0, 13);
    await applyLink('https://example.com/changed');
    assert.equal(await markdown(), '[Подробнее 🔗!](https://example.com/changed)');
    await open('before [old](https://old.example/) after');
    await select(0, 16);
    await applyLink('https://new.example/');
    assert.equal(await markdown(), '[before old after](https://new.example/)');
    await open(await markdown());
    assert.equal(await editor.innerText(), 'before old after');
    assert.equal(await editor.locator('a').count(), 1);
    assert.equal(await editor.locator('a').getAttribute('href'), 'https://new.example/');
    await open('[**old**](https://example.com/)');
    await select(0, 3);
    await page.keyboard.insertText('<Read & learn>');
    assert.equal(await markdown(), '[**<Read & learn\\>**](https://example.com/)');
    assert.equal(await editor.locator('a').textContent(), '<Read & learn>');
    assert.equal(await editor.locator('a strong, a b').textContent(), '<Read & learn>');
    await open('**before [old](https://example.com/) after**');
    await select(7, 10);
    await page.keyboard.insertText('new label');
    assert.ok((await markdown()).includes('[new label](https://example.com/)'));
    await open(await markdown());
    assert.equal(await editor.innerText(), 'before new label after');
    await select(7, 16);
    await pressed('Жирный', true);
    await open('aa[aa](https://example.com/)');
    await select(1, 3);
    await page.keyboard.insertText('REPLACED');
    assert.equal(await editor.innerText(), 'aREPLACEDa');
    await open('[old](https://example.com/)');
    await select(0, 3);
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', 'Новое название');
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
      );
    });
    assert.equal(await markdown(), '[Новое название](https://example.com/)');
    await open('[старое](https://example.com/)');
    await select(0, 6);
    const session = await context.newCDPSession(page);
    await session.send('Input.imeSetComposition', {
      text: 'новое',
      selectionStart: 5,
      selectionEnd: 5,
    });
    await session.send('Input.insertText', { text: 'новое' });
    assert.equal(await markdown(), '[новое](https://example.com/)');
    await session.detach();
    await open('[old](https://example.com/)');
    await select(3);
    assert.equal(
      await editor.evaluate((element) => {
        const text = element.querySelector('a').firstChild;
        const event = new InputEvent('beforeinput', {
          inputType: 'insertReplacementText',
          data: 'corrected',
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(event, 'getTargetRanges', {
          value: () => [
            new StaticRange({
              startContainer: text,
              startOffset: 0,
              endContainer: text,
              endOffset: text.length,
            }),
          ],
        });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      true,
    );
    assert.equal(await markdown(), '[corrected](https://example.com/)');
    await open('[old](https://example.com/)');
    await select(0, 3);
    await page.evaluate(() => {
      const original = document.execCommand.bind(document);
      document.execCommand = (command, ...args) =>
        command === 'insertHTML' ? false : original(command, ...args);
    });
    await page.keyboard.insertText('Text survives an unavailable command');
    assert.equal(await editor.innerText(), 'Text survives an unavailable command');
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
