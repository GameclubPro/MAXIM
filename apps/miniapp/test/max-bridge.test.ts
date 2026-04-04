import assert from 'node:assert/strict';
import test from 'node:test';
import { openMaxBotLink } from '../src/lib/max-bridge';

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

test('openMaxBotLink falls back to location assign when bridge is unavailable', () => {
  const assignedUrls: string[] = [];
  setMockWindow(null, assignedUrls);

  openMaxBotLink('https://max.ru/chats/chat-1/message/42');
  assert.deepEqual(assignedUrls, ['https://max.ru/chats/chat-1/message/42']);
});

test('openMaxBotLink opens MAX deep links inside bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://max.ru/chats/chat-1/message/42');
  assert.deepEqual(opened, [{ kind: 'max', url: 'https://max.ru/chats/chat-1/message/42' }]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLink opens external links through bridge browser API', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://example.com/path');
  assert.deepEqual(opened, [{ kind: 'external', url: 'https://example.com/path' }]);
  assert.deepEqual(assignedUrls, []);
});
