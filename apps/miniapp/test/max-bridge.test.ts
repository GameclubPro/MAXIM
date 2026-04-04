import assert from 'node:assert/strict';
import test from 'node:test';
import { openLinkInMaxBridgeIfAvailable } from '../src/lib/max-bridge';

type MockBridge = {
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
};

type MockWindow = {
  location: {
    href: string;
    assign: (url: string) => void;
  };
  MAX?: {
    WebApp?: MockBridge;
  };
  WebApp?: MockBridge;
};

const originalWindow = globalThis.window;

function setMockWindow(bridge: MockBridge | null, assignedUrls: string[]): void {
  const location = {
    href: 'https://maxim.play-team.ru/app/',
    assign: (url: string) => {
      assignedUrls.push(url);
    },
  };
  const nextWindow: MockWindow = bridge
    ? {
        location,
        MAX: {
          WebApp: bridge,
        },
      }
    : {
        location,
      };

  Object.assign(globalThis, {
    window: nextWindow,
  });
}

test.afterEach(() => {
  Object.assign(globalThis, {
    window: originalWindow,
  });
});

test('openLinkInMaxBridgeIfAvailable returns false when bridge is unavailable', () => {
  const assignedUrls: string[] = [];
  setMockWindow(null, assignedUrls);

  assert.equal(openLinkInMaxBridgeIfAvailable('https://max.ru/chats/chat-1/message/42'), false);
  assert.deepEqual(assignedUrls, []);
});

test('openLinkInMaxBridgeIfAvailable opens MAX deep links inside bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  assert.equal(openLinkInMaxBridgeIfAvailable('https://max.ru/chats/chat-1/message/42'), true);
  assert.deepEqual(opened, [{ kind: 'max', url: 'https://max.ru/chats/chat-1/message/42' }]);
  assert.deepEqual(assignedUrls, []);
});

test('openLinkInMaxBridgeIfAvailable opens external links through bridge browser API', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  assert.equal(openLinkInMaxBridgeIfAvailable('https://example.com/path'), true);
  assert.deepEqual(opened, [{ kind: 'external', url: 'https://example.com/path' }]);
  assert.deepEqual(assignedUrls, []);
});
