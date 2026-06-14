import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveLaunchRoute } from '../src/lib/launch-route';

type MutableWindow = Window &
  typeof globalThis & {
    WebApp?: {
      initDataUnsafe?: {
        start_param?: string;
      };
      startParam?: string;
    };
    MAX?: {
      WebApp?: {
        initDataUnsafe?: {
          start_param?: string;
        };
        startParam?: string;
      };
    };
    atob: typeof globalThis.atob;
  };

function assignWindow(url: string, overrides: Partial<MutableWindow> = {}): void {
  const windowLike = {
    location: new URL(url),
    atob: globalThis.atob,
    ...overrides,
  } as MutableWindow;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowLike,
  });
}

function encodeRouteStartParam(route: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      k: 'route',
      r: route,
    }),
    'utf8',
  ).toString('base64url');
  return `mr-${payload}`;
}

test.afterEach(() => {
  delete (globalThis as { window?: Window }).window;
});

test('resolves chat activity route from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/events'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/chat/-68085832859751/events');
});

test('resolves channel stats route from startapp payload', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/channel/-68085832859751/stats'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/channel/-68085832859751/stats');
});

test('resolves startapp from hash-route query parameters', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/#/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/-68085832859751/settings'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/chat/-68085832859751/settings');
});

test('normalizes legacy /chats launcher route to root', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chats'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/');
});
