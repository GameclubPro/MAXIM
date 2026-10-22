import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  ensureMiniappDevServer,
  stopChildProcess,
} from '../../../scripts/miniapp-local-server.mjs';
import { installMaxBridgeShimInitScript } from '../../../scripts/miniapp-max-bridge-shim.mjs';

const base = process.env.COMMENT_DIALOG_BASE_URL || 'http://127.0.0.1:3014/app/';
const server = await ensureMiniappDevServer(base);
const browser = await chromium.launch();
const fixture = new URL('test/comment-dialog.fixture.tsx', base).href;
const attachmentSelector = '.channel-dialog-compose__attachment';
const fileSelector = '.channel-dialog-compose input[type="file"]:not([accept])';
const draftFile = (name) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });

async function withDeadline(promise, description) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${description}`)),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function openScenario({ failImport = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.route('https://st.max.ru/js/max-web-app.js', (route) =>
    route.fulfill({ body: '' }),
  );
  await context.route('**/src/main.tsx', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `import ${JSON.stringify(fixture)};`,
    }),
  );
  let importRequests = 0;
  let releaseImport;
  let markImportStarted;
  const importStarted = new Promise((resolve) => {
    markImportStarted = resolve;
  });
  const importGate = new Promise((resolve) => {
    releaseImport = resolve;
  });
  await context.route('**/src/lib/dialog-attachments.ts*', async (route) => {
    importRequests += 1;
    markImportStarted();
    await importGate;
    if (failImport) {
      await route.abort('failed');
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `${await response.text()}\n;globalThis.commentAttachmentModuleLoaded = true;`,
    });
  });
  await context.addInitScript(() => {
    window.commentAttachmentReads = 0;
    window.commentAttachmentReadCompletions = 0;
    window.commentHoldAttachmentReads = false;
    window.commentPendingAttachmentReads = [];
    const read = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function (file) {
      window.commentAttachmentReads += 1;
      this.addEventListener('loadend', () => {
        window.commentAttachmentReadCompletions += 1;
      });
      const resume = () => read.call(this, file);
      if (window.commentHoldAttachmentReads) window.commentPendingAttachmentReads.push(resume);
      else resume();
    };
    window.commentReleaseNextAttachmentRead = () =>
      window.commentPendingAttachmentReads.shift()?.();
  });
  await installMaxBridgeShimInitScript(
    context,
    {
      platform: 'web',
      safeTop: 0,
      safeBottom: 0,
    },
    { colorScheme: 'light' },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator('.channel-dialog-message').first().waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(importRequests, 0, 'rendering comments must not fetch attachment preparation');
  await page.getByRole('button', { name: 'Вложения и эмодзи', exact: true }).click();
  return {
    context,
    page,
    errors,
    importStarted: () => withDeadline(importStarted, 'attachment preparation import'),
    releaseImport,
  };
}

try {
  {
    const scenario = await openScenario();
    const { page, context, importStarted, releaseImport, errors } = scenario;
    try {
      await page.locator(fileSelector).setInputFiles(draftFile('old-account.txt'));
      await importStarted();
      await page.evaluate(() => window.commentTest.setUserId('another-user'));
      await page.waitForFunction(
        () => !document.querySelector('.channel-dialog-compose__meta[role="status"]'),
      );
      releaseImport();
      await page.waitForFunction(() => window.commentAttachmentModuleLoaded === true);
      assert.equal(
        await page.evaluate(() => window.commentAttachmentReads),
        0,
        'account switch during import must prevent reading the old selection',
      );
      assert.equal(await page.locator(attachmentSelector).count(), 0);
      assert.equal(await page.locator(fileSelector).inputValue(), '');
      assert.deepEqual(errors, []);
    } finally {
      releaseImport();
      await context.close();
    }
  }
  {
    const { page, context, importStarted, releaseImport, errors } = await openScenario();
    try {
      await page.locator(fileSelector).setInputFiles(draftFile('before-edit.txt'));
      await importStarted();
      await page.locator('.channel-dialog-message__bubble').last().press('Enter');
      await page.getByRole('button', { name: 'Изменить', exact: true }).click();
      await page.getByRole('button', { name: 'Отменить редактирование', exact: true }).waitFor();
      releaseImport();
      await page.waitForFunction(() => window.commentAttachmentModuleLoaded === true);
      assert.equal(
        await page.evaluate(() => window.commentAttachmentReads),
        0,
        'replacing the draft with an edit must cancel import-delayed attachments',
      );
      assert.equal(await page.locator(attachmentSelector).count(), 0);
      assert.deepEqual(errors, []);
    } finally {
      releaseImport();
      await context.close();
    }
  }
  {
    const { page, context, importStarted, releaseImport, errors } = await openScenario();
    try {
      await page.evaluate(() => {
        window.commentHoldAttachmentReads = true;
      });
      await page.locator(fileSelector).setInputFiles(draftFile('old-reading.txt'));
      await importStarted();
      releaseImport();
      await page.waitForFunction(() => window.commentAttachmentReads === 1);
      await page.evaluate(() => window.commentTest.setUserId('another-user'));
      await page.locator(fileSelector).waitFor({ state: 'attached' });
      await page.waitForFunction(
        (selector) => !document.querySelector(selector).disabled,
        fileSelector,
      );
      await page.locator(fileSelector).setInputFiles(draftFile('new-reading.txt'));
      await page.waitForFunction(() => window.commentAttachmentReads === 2);
      await page.evaluate(() => window.commentReleaseNextAttachmentRead());
      await page.waitForFunction(() => window.commentAttachmentReadCompletions === 1);
      assert.equal(
        await page.locator(attachmentSelector).count(),
        0,
        'a prepared attachment from the previous account must not enter the new draft',
      );
      assert.equal(
        await page.locator(fileSelector).isDisabled(),
        true,
        'old completion must leave the new preparation active',
      );
      assert.match(
        await page.locator(fileSelector).inputValue(),
        /new-reading\.txt$/u,
        'old cleanup must not reset the current selection',
      );
      await page.evaluate(() => window.commentReleaseNextAttachmentRead());
      await page.locator(attachmentSelector).waitFor();
      assert.match(await page.locator(attachmentSelector).innerText(), /new-reading\.txt/u);
      assert.equal(await page.locator(attachmentSelector).count(), 1);
      await page.waitForFunction(
        (selector) => !document.querySelector(selector).disabled,
        fileSelector,
      );
      assert.equal(await page.locator(fileSelector).inputValue(), '');
      assert.deepEqual(errors, []);
    } finally {
      releaseImport();
      await context.close();
    }
  }
  {
    const { page, context, importStarted, releaseImport, errors } = await openScenario({
      failImport: true,
    });
    try {
      await page.locator(fileSelector).setInputFiles(draftFile('failed-load.txt'));
      await importStarted();
      releaseImport();
      await page.getByText('Файл не добавлен', { exact: true }).waitFor();
      await page.waitForFunction(
        (selector) => !document.querySelector(selector).disabled,
        fileSelector,
      );
      assert.equal(
        await page.locator(fileSelector).inputValue(),
        '',
        'failed import resets the picker',
      );
      assert.equal(await page.locator(attachmentSelector).count(), 0);
      assert.equal(await page.evaluate(() => window.commentAttachmentReads), 0);
      assert.deepEqual(errors, []);
    } finally {
      releaseImport();
      await context.close();
    }
  }
  console.log(
    'PASS comment attachments: lazy import, account/edit cancellation, stale file completion ownership, load failure cleanup',
  );
} finally {
  await browser.close();
  await stopChildProcess(server);
}
