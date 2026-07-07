import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateHashRouterLegacyPathFromWindow } from '../src/lib/hash-router-legacy-path';
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
  const location = new URL(url) as URL & { href: string };
  const windowLike = {
    location,
    history: {
      state: null,
      replaceState: (_state: unknown, _unused: string, nextUrl: string) => {
        location.href = new URL(nextUrl, location.href).href;
      },
    },
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

test('prefers signed initData start_param over bridge and URL fallbacks', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/url/events'),
    )}`,
    {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/bridge/events'),
        },
      },
    },
  );

  assert.equal(
    resolveLaunchRoute(
      `query_id=test&start_param=${encodeURIComponent(
        encodeRouteStartParam('/chat/signed/events'),
      )}&hash=ok`,
    ),
    '/chat/signed/events',
  );
});

test('prefers bridge start_param over URL fallback when signed initData has no launcher', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chat/url/events'),
    )}`,
    {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/bridge/events'),
        },
      },
    },
  );

  assert.equal(resolveLaunchRoute('query_id=test&hash=ok'), '/chat/bridge/events');
});

test('prefers MAX bridge start_param over legacy WebApp fallback', () => {
  assignWindow('https://maxim.play-team.ru/app/', {
    WebApp: {
      initDataUnsafe: {
        start_param: encodeRouteStartParam('/chat/legacy/events'),
      },
    },
    MAX: {
      WebApp: {
        initDataUnsafe: {
          start_param: encodeRouteStartParam('/chat/max/events'),
        },
      },
    },
  });

  assert.equal(resolveLaunchRoute('query_id=test&hash=ok'), '/chat/max/events');
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

test('hash router builds keep direct legacy deep path visible through the hash route', async () => {
  const previousMode = globalThis.__MAXIM_ROUTER_MODE__;

  Object.defineProperty(globalThis, '__MAXIM_ROUTER_MODE__', {
    configurable: true,
    value: 'hash',
  });
  assignWindow('https://app2.major-maksimov.ru/app/chat/-68085832859751/settings?focus=rules');

  migrateHashRouterLegacyPathFromWindow();

  assert.equal(
    window.location.href,
    'https://app2.major-maksimov.ru/app/#/chat/-68085832859751/settings?focus=rules',
  );

  Object.defineProperty(globalThis, '__MAXIM_ROUTER_MODE__', {
    configurable: true,
    value: previousMode,
  });
});

test('normalizes legacy /chats launcher route to root', () => {
  assignWindow(
    `https://maxim.play-team.ru/app/?startapp=${encodeURIComponent(
      encodeRouteStartParam('/chats'),
    )}`,
  );

  assert.equal(resolveLaunchRoute(''), '/');
});
