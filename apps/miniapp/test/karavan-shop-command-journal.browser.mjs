import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import { captureBrowserLaunchOptions } from '../../../scripts/miniapp-smartphone.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const server = await createServer({
  configFile: `${root}apps/miniapp/vite.config.ts`,
  root: `${root}apps/miniapp`,
  base: '/',
  appType: 'custom',
  server: { host: '127.0.0.1', port: 0, fs: { allow: [root] } },
});
const originalRequests = new Map(),
  attempts = new Map();
server.middlewares.use('/app/journal-harness', (_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(
    `<!doctype html><title>Shop storage</title><script type="module">import * as journal from "/@fs/${root}apps/miniapp/src/pages/settings/karavan-shop/command-journal.ts";import * as api from "/@fs/${root}apps/miniapp/src/lib/api/karavan-shop-client.ts";globalThis.h={...journal,...api,transport:{request:async (_path,init)=>{const response=await fetch('/app/mock-shop-command',init);const result=await response.json();if(response.headers.get('X-Simulated-Lost-Response')==='1')throw new Error('Connection lost after commit');return result;},requestKeepalive(){}}};</script>`,
  );
});
server.middlewares.use('/app/mock-shop-command', (request, response) => {
  let body = '';
  request.on('data', (part) => {
    body += part;
  });
  request.on('end', () => {
    const input = JSON.parse(body),
      id = input.commandId;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (!originalRequests.has(id)) {
      originalRequests.set(id, body);
      response.setHeader('X-Simulated-Lost-Response', '1');
    }
    assert.equal(
      body,
      originalRequests.get(id),
      'manual retry must preserve the whole frozen envelope',
    );
    const command = input.command;
    const data =
      command.operation === 'image'
        ? { url: 'https://assets.test/original.jpg' }
        : command.operation === 'appearance_apply'
          ? {
              draft: command.input.appearance,
              published: command.input.appearance,
              revision: 2,
              hasChanges: false,
            }
          : {
              id: '33333333-3333-4333-8333-333333333333',
              expiresAt: command.input.expiresAt,
              maxUses: command.input.maxUses,
              usedCount: 0,
              code: 'original-secure-invite',
              revoked: false,
              url: 'https://max.ru/seller?startapp=original-secure-invite',
            };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ operation: command.operation, data }));
  });
});
await server.listen();
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Missing owned server');
const url = `http://127.0.0.1:${address.port}/app/journal-harness`;
try {
  for (const [engine, browserType] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    const browser = await browserType.launch(captureBrowserLaunchOptions(engine, url));
    try {
      const context = await browser.newContext(),
        page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('response', (response) => {
        if (response.status() >= 400 && !response.url().includes('mock-shop-command'))
          errors.push(`${response.status()}: ${response.url()}`);
      });
      const open = async (target) => {
        await target.goto(url);
        await target
          .waitForFunction(() => Boolean(globalThis.h), undefined, { timeout: 10000 })
          .catch((cause) => {
            assert.deepEqual(errors, []);
            throw cause;
          });
      };
      await open(page);
      const scope = {
        actorMaxUserId: '1001',
        chatId: '-123',
        marketplaceId: '11111111-1111-4111-8111-111111111111',
        expectedBindingGeneration: 1,
      };
      const appearance = {
        name: 'Магазин соседей',
        description: null,
        logoImageUrl: null,
        coverImageUrl: null,
        accent: 'blue',
        blocks: [
          { id: 'categories', visible: true },
          { id: 'pinned', visible: true },
          { id: 'sellers', visible: true },
        ],
      };
      for (const operation of ['image', 'appearance_apply', 'invitation_create']) {
        const reserved = await page.evaluate(
          async ({ scope, appearance, operation }) => {
            const h = globalThis.h,
              commandId = crypto.randomUUID();
            const command = {
              operation,
              input:
                operation === 'image'
                  ? {
                      commandId,
                      fileName: 'cover.jpg',
                      mimeType: 'image/jpeg',
                      dataBase64: 'AQIDBAUGBwg=',
                    }
                  : operation === 'appearance_apply'
                    ? { commandId, expectedRevision: 1, appearance }
                    : {
                        commandId,
                        expiresAt: new Date(Date.now() + 86400000).toISOString(),
                        maxUses: 1000,
                        targetMaxUserId: null,
                      },
            };
            const request = h.prepareShopRequest(
              {
                chatId: scope.chatId,
                marketplaceId: scope.marketplaceId,
                expectedBindingGeneration: scope.expectedBindingGeneration,
              },
              command,
            );
            const value = await h.reserveShopCommand(scope, request, {
              owner: operation,
              page: operation === 'invitation_create' ? 'home' : 'appearance',
              ...(operation === 'image'
                ? { imageTarget: 'coverImageUrl', appearanceDraft: appearance }
                : {}),
            });
            let current = await h.claimShopCommand(value);
            try {
              await h.dispatchShopRequest(h.transport, await h.restoreShopCommand(current));
              throw new Error('Expected lost response');
            } catch (cause) {
              if (cause.message === 'Expected lost response') throw cause;
              current = await h.releaseShopCommand(current);
            }
            return {
              request,
              hash: current.pending.hash,
              id: current.pending.id,
              count: current.pending.dispatchCount,
            };
          },
          { scope, appearance, operation },
        );
        assert.equal(reserved.count, 1);
        assert.equal(attempts.get(reserved.request.commandId), 1);
        await page.reload();
        await page.waitForFunction(() => Boolean(globalThis.h));
        const restored = await page.evaluate(async (scope) => {
          const h = globalThis.h,
            current = await h.loadShopCommandJournal(scope);
          try {
            await h.assertShopEntryWriteAvailable(
              scope.actorMaxUserId,
              scope.chatId,
              scope.marketplaceId,
            );
            throw new Error('Expected connection fence');
          } catch (cause) {
            if (cause.message === 'Expected connection fence') throw cause;
          }
          return {
            request: await h.restoreShopCommand(current),
            id: current.pending.id,
            hash: current.pending.hash,
            count: current.pending.dispatchCount,
          };
        }, scope);
        assert.deepEqual(restored, {
          request: reserved.request,
          id: reserved.id,
          hash: reserved.hash,
          count: 1,
        });
        assert.equal(attempts.get(reserved.request.commandId), 1, 'reload must never dispatch');
        const second = await context.newPage();
        await open(second);
        const fence = await second.evaluate(
          async ({ scope, request }) => {
            const h = globalThis.h,
              other = { ...scope, chatId: '-456' },
              rebound = { ...scope, expectedBindingGeneration: 2 };
            const overlapping = await h.loadShopCommandJournal(other);
            const oldGeneration = await h.loadShopCommandJournal(rebound);
            let blocked = false;
            try {
              await h.reserveShopCommand(
                other,
                { ...request, chatId: '-456' },
                { owner: 'other', page: 'home' },
              );
            } catch {
              blocked = true;
            }
            const changedActor = await h.loadShopCommandJournal({
              ...scope,
              actorMaxUserId: '1002',
            });
            return { original: overlapping.key, rebound: oldGeneration.key, blocked, changedActor };
          },
          { scope, request: reserved.request },
        );
        const key = JSON.stringify([
          scope.actorMaxUserId,
          scope.chatId,
          scope.marketplaceId,
          scope.expectedBindingGeneration,
        ]);
        assert.deepEqual(fence, { original: key, rebound: key, blocked: true, changedActor: null });
        const claimed = await page.evaluate(async (scope) => {
          const h = globalThis.h;
          return h.claimShopCommand(await h.loadShopCommandJournal(scope));
        }, scope);
        const blockedLease = await second.evaluate(async (scope) => {
          const h = globalThis.h;
          try {
            await h.claimShopCommand(await h.loadShopCommandJournal(scope));
            return false;
          } catch {
            return true;
          }
        }, scope);
        assert.equal(blockedLease, true);
        const settled = await page.evaluate(async (current) => {
          const h = globalThis.h,
            result = await h.dispatchShopRequest(h.transport, await h.restoreShopCommand(current));
          return h.settleShopCommand(current, result);
        }, claimed);
        assert.equal(settled.pending, null);
        await page.evaluate(
          (scope) =>
            globalThis.h.assertShopEntryWriteAvailable(
              scope.actorMaxUserId,
              scope.chatId,
              scope.marketplaceId,
            ),
          scope,
        );
        assert.equal(settled.results[operation].response.operation, operation);
        assert.equal(attempts.get(reserved.request.commandId), 2);
        if (operation === 'image')
          assert.equal(settled.appearanceDraft.coverImageUrl, 'https://assets.test/original.jpg');
        if (operation === 'appearance_apply') assert.equal(settled.appearanceDraft, null);
        await page.reload();
        await page.waitForFunction(() => Boolean(globalThis.h));
        const confirmed = await page.evaluate(
          (scope) => globalThis.h.loadShopCommandJournal(scope),
          scope,
        );
        assert.deepEqual(confirmed.results[operation], settled.results[operation]);
        await second.close();
      }
      assert.deepEqual(errors, []);
      await context.close();
      process.stdout.write(
        `${engine}: lost committed response, exact retry after reload, persistent binary/result, actor/generation/shared-shop fences and concurrent lease passed\n`,
      );
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
