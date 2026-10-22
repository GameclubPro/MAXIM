import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBroadcastRequestId,
  getChannelBroadcastComposerClientResetState,
  getChannelManagedAutopostRules,
  sendChannelBroadcast,
  sendChannelBroadcastTest,
} from '../src/lib/api/channel-settings-client';
import type { SendBroadcastPayload } from '../src/lib/api/shared-types';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';

type Call = { path: string; init?: ApiRequestInit };
const receipt = {
  sourceChatId: 'channel-1',
  targetChats: 1,
  sentChats: 1,
  failedChats: 0,
  sentChatIds: ['channel-1'],
  failedChatIds: [],
};
function payload(overrides: Partial<SendBroadcastPayload> = {}): SendBroadcastPayload {
  return {
    text: 'Новости канала',
    textFormat: 'plain',
    targetMode: 'current',
    targetChatIds: ['channel-1'],
    applyToAllChats: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Подробнее',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    scheduleMode: 'legacy',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    ...overrides,
  };
}
function transport(response: unknown, calls: Call[]): ApiTransport {
  return {
    async request(path, init) {
      calls.push({ path, init });
      return response;
    },
    requestKeepalive() {},
  };
}

test('lazy channel send preserves the caller request ID and performs one canonical request', async () => {
  const calls: Call[] = [];
  const result = await sendChannelBroadcast(
    transport(receipt, calls),
    'channel-1',
    payload({ requestId: 'caller_request_123' }),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/channels/channel-1/broadcast');
  assert.equal(calls[0]!.init?.method, 'POST');
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.requestId, 'caller_request_123');
  assert.equal(body.text, 'Новости канала');
  assert.equal(result.sentChats, 1);
  assert.equal(result.scheduleTimezone, 'Europe/Moscow');
});

test('lazy channel send creates a valid request ID and never retries an uncertain response', async () => {
  const calls: Call[] = [];
  const uncertainty = new Error('Response lost after dispatch');
  const api: ApiTransport = {
    async request(path, init) {
      calls.push({ path, init });
      throw uncertainty;
    },
    requestKeepalive() {},
  };
  await assert.rejects(
    sendChannelBroadcast(api, 'channel-1', payload()),
    (error) => error === uncertainty,
  );
  assert.equal(calls.length, 1);
  assert.match(JSON.parse(String(calls[0]!.init?.body)).requestId, /^[A-Za-z0-9_-]{8,128}$/u);
  assert.match(createBroadcastRequestId(), /^[A-Za-z0-9_-]{8,128}$/u);
});

test('lazy channel send rejects invalid input before dispatch and invalid receipts after one dispatch', async () => {
  const calls: Call[] = [];
  await assert.rejects(
    sendChannelBroadcast(transport(receipt, calls), 'channel-1', payload({ text: '' })),
  );
  assert.equal(calls.length, 0);
  await assert.rejects(sendChannelBroadcast(transport({}, calls), 'channel-1', payload()));
  assert.equal(calls.length, 1);
});

test('lazy test send forces the current channel and clears publishing schedule and cycles', async () => {
  const calls: Call[] = [];
  const result = await sendChannelBroadcastTest(
    transport({ delivered: true, messageId: 'message-1', chatId: 'channel-1', url: null }, calls),
    'channel-1',
    payload({
      targetMode: 'all',
      targetChatIds: ['unrelated-channel'],
      applyToAllChats: true,
      scheduleMode: 'calendar',
      scheduledSlots: ['2099-01-01T12:00:00.000Z'],
      sendAt: '2099-01-01T12:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 24,
      cycleCount: 12,
    }),
  );
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.path, '/channels/channel-1/broadcast/test');
  const body = JSON.parse(String(calls[0]!.init?.body));
  assert.equal(body.targetMode, 'current');
  assert.deepEqual(body.targetChatIds, ['channel-1']);
  assert.equal(body.applyToAllChats, false);
  assert.equal(body.scheduleMode, 'legacy');
  assert.deepEqual(body.scheduledSlots, []);
  assert.equal(body.sendAt, null);
  assert.equal(body.cycleEnabled, false);
  assert.equal(body.cycleEveryHours, 1);
  assert.equal(body.cycleCount, 1);
});

test('lazy legacy reads forward cancellation and preserve response validation', async () => {
  const calls: Call[] = [];
  const controller = new AbortController();
  const reset = await getChannelBroadcastComposerClientResetState(
    transport({ resetAt: ' 2026-10-22T12:00:00.000Z ' }, calls),
    'channel-1',
    { signal: controller.signal },
  );
  assert.deepEqual(reset, { resetAt: '2026-10-22T12:00:00.000Z' });
  assert.equal(calls[0]!.init?.signal, controller.signal);
  await assert.rejects(
    getChannelManagedAutopostRules(transport({}, calls), 'channel-1'),
    /Invalid channel managed autopost rules response/u,
  );
  assert.equal(calls.length, 2);
});
