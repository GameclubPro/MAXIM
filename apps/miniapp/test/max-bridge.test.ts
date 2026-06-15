import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLegacyAndroidSettingsDrilldownUserAgent,
  openMaxBotLink,
  openMaxBotLinkAndClose,
  readyMaxMiniApp,
} from '../src/lib/max-bridge';

type MockBridge = {
  initData?: string | null;
  init_data?: string | null;
  initDataUnsafe?: Record<string, unknown>;
  init_data_unsafe?: Record<string, unknown>;
  ready?: () => void;
  close?: () => void;
  openLink?: (url: string) => void;
  openMaxLink?: (url: string) => void;
};

type MockWindow = {
  __MAXIM_FORCE_NATIVE_VISUAL_MODE__?: boolean;
  __MAXIM_VISUAL_BRIDGE__?: MockBridge;
  location: {
    href: string;
    assign: (url: string) => void;
  };
  open?: (url: string, target?: string, features?: string) => unknown;
  setTimeout: typeof setTimeout;
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
        setTimeout,
        MAX: {
          WebApp: bridge,
        },
      }
    : {
        location,
        setTimeout,
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

test('readyMaxMiniApp ignores browser bridge stubs without init data', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initDataUnsafe: {},
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );

  readyMaxMiniApp();

  assert.equal(readyCount, 0);
});

test('readyMaxMiniApp keeps native ready when bridge init data exists', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initData: 'query_id=abc&hash=def',
      initDataUnsafe: {},
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );

  readyMaxMiniApp();

  assert.equal(readyCount, 1);
});

test('readyMaxMiniApp skips forced visual mode without the visual bridge shim', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  setMockWindow(
    {
      initData: 'query_id=abc&hash=def',
      ready: () => {
        readyCount += 1;
      },
    },
    assignedUrls,
  );
  globalThis.window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;

  readyMaxMiniApp();

  assert.equal(readyCount, 0);
});

test('readyMaxMiniApp allows forced visual mode when the visual bridge shim is installed', () => {
  const assignedUrls: string[] = [];
  let readyCount = 0;
  const bridge = {
    initData: 'query_id=abc&hash=def',
    ready: () => {
      readyCount += 1;
    },
  };
  setMockWindow(bridge, assignedUrls);
  globalThis.window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
  globalThis.window.__MAXIM_VISUAL_BRIDGE__ = bridge;

  readyMaxMiniApp();

  assert.equal(readyCount, 1);
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

test('openMaxBotLink opens bot start handoff links through MAX bridge', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  openMaxBotLink('https://max.ru/777000_bot?start=broadcast_handoff');

  assert.deepEqual(opened, [
    { kind: 'max', url: 'https://max.ru/777000_bot?start=broadcast_handoff' },
  ]);
  assert.deepEqual(assignedUrls, []);
});

test('openMaxBotLinkAndClose closes miniapp after bot start handoff bridge open', async () => {
  const assignedUrls: string[] = [];
  const opened: string[] = [];
  let closeCount = 0;
  setMockWindow(
    {
      close: () => {
        closeCount += 1;
      },
      openMaxLink: (url) => opened.push(url),
    },
    assignedUrls,
  );

  assert.equal(openMaxBotLinkAndClose('https://max.ru/777000_bot?start=broadcast_handoff'), true);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.deepEqual(opened, ['https://max.ru/777000_bot?start=broadcast_handoff']);
  assert.deepEqual(assignedUrls, []);
  assert.equal(closeCount, 1);
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

test('openMaxBotLink avoids bridge browser API for inline preview urls', () => {
  const assignedUrls: string[] = [];
  const opened: Array<{ kind: 'max' | 'external'; url: string }> = [];
  const popupUrls: string[] = [];
  setMockWindow(
    {
      openMaxLink: (url) => opened.push({ kind: 'max', url }),
      openLink: (url) => opened.push({ kind: 'external', url }),
    },
    assignedUrls,
  );

  globalThis.window.open = (url) => {
    popupUrls.push(url);
    return {};
  };

  openMaxBotLink('data:image/webp;base64,YQ==');

  assert.deepEqual(opened, []);
  assert.deepEqual(popupUrls, ['data:image/webp;base64,YQ==']);
  assert.deepEqual(assignedUrls, []);
});

test('isLegacyAndroidSettingsDrilldownUserAgent gates old Android and WebView versions', () => {
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 8.1.0; Pixel Build/OPM1) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/83.0.4103.106 Mobile Safari/537.36 wv',
    ),
    true,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 10; Pixel Build/QP1A) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/99.0.4844.88 Mobile Safari/537.36 wv',
    ),
    true,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    ),
    false,
  );
  assert.equal(
    isLegacyAndroidSettingsDrilldownUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    ),
    false,
  );
});
