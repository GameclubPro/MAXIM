import assert from 'node:assert/strict';
import test from 'node:test';
import { createBotDialogHandoffCoordinator } from '../src/lib/bot-dialog-handoff';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('bot dialog handoff ignores duplicate activation while resolution is pending', async () => {
  const deferred = createDeferred<string | null>();
  const coordinator = createBotDialogHandoffCoordinator();
  const opened: string[] = [];
  const first = coordinator.run(
    () => deferred.promise,
    (url) => {
      opened.push(url);
      return true;
    },
  );

  await assert.doesNotReject(async () => {
    assert.equal(
      await coordinator.run(
        async () => 'https://max.ru/duplicate',
        () => true,
      ),
      'busy',
    );
  });
  deferred.resolve('https://max.ru/launch-bot');

  assert.equal(await first, 'opened');
  assert.deepEqual(opened, ['https://max.ru/launch-bot']);
});

test('bot dialog handoff never opens after it is cancelled', async () => {
  const deferred = createDeferred<string | null>();
  const coordinator = createBotDialogHandoffCoordinator();
  let opened = false;
  const pending = coordinator.run(
    () => deferred.promise,
    () => {
      opened = true;
      return true;
    },
  );

  assert.equal(coordinator.cancel(), true);
  deferred.resolve('https://max.ru/launch-bot');

  assert.equal(await pending, 'cancelled');
  assert.equal(opened, false);
});

test('failed bot dialog handoff releases the activation lock for retry', async () => {
  const coordinator = createBotDialogHandoffCoordinator();

  assert.equal(
    await coordinator.run(
      async () => 'https://max.ru/launch-bot',
      () => false,
    ),
    'failed',
  );
  assert.equal(
    await coordinator.run(
      async () => 'https://max.ru/launch-bot',
      () => true,
    ),
    'opened',
  );
});
