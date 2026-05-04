import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getInitData,
  getInitDataUserId,
  readUserIdFromInitData,
  waitForInitData,
} from '../src/lib/init-data';

type MutableWindow = Window &
  typeof globalThis & {
    addEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
    removeEventListener?: (type: string, listener: EventListenerOrEventListenerObject) => void;
    dispatchEvent?: (event: Event) => boolean;
    setInterval?: typeof globalThis.setInterval;
    clearInterval?: typeof globalThis.clearInterval;
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
    WebApp?: {
      initData?: string;
      init_data?: string;
      initDataUnsafe?: {
        user?: {
          id?: number | string;
        };
      };
      init_data_unsafe?: {
        user?: {
          id?: number | string;
        };
      };
    };
    MAX?: {
      WebApp?: {
        initData?: string;
        init_data?: string;
        initDataUnsafe?: {
          user?: {
            id?: number | string;
          };
        };
        init_data_unsafe?: {
          user?: {
            id?: number | string;
          };
        };
      };
    };
  };

function createEventTarget() {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  return {
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      const bucket = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event: Event) {
      const bucket = listeners.get(event.type);
      if (!bucket) {
        return true;
      }

      for (const listener of bucket) {
        if (typeof listener === 'function') {
          listener(event);
        } else {
          listener.handleEvent(event);
        }
      }

      return true;
    },
  };
}

function assignWindow(url: string, overrides: Partial<MutableWindow> = {}): void {
  const eventTarget = createEventTarget();
  const windowLike = {
    location: new URL(url),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    ...eventTarget,
    ...overrides,
  } as MutableWindow;

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: windowLike,
  });
}

test.afterEach(() => {
  delete (globalThis as { window?: Window }).window;
});

test('prefers fresh bridge initData over stale query init_data', () => {
  assignWindow('https://maxim.play-team.ru/app/?init_data=query-hash%3Dold', {
    WebApp: {
      initData: 'bridge-hash=new',
    },
  });

  assert.equal(getInitData(), 'bridge-hash=new');
});

test('falls back to query init_data when bridge initData is missing', () => {
  assignWindow('https://maxim.play-team.ru/app/?WebAppData=query-hash%3Dnew');

  assert.equal(getInitData(), 'query-hash=new');
});

test('falls back to hash WebAppData when neither bridge nor query values exist', () => {
  assignWindow('https://maxim.play-team.ru/app/#WebAppData=hash-hash%3Dnew');

  assert.equal(getInitData(), 'hash-hash=new');
});

test('prefers hash WebAppData over stale query init_data when bridge initData is missing', () => {
  assignWindow(
    'https://maxim.play-team.ru/app/?init_data=query-hash%3Dstale#WebAppData=hash-hash%3Dfresh',
  );

  assert.equal(getInitData(), 'hash-hash=fresh');
});

test('reads the user id from initData payload', () => {
  assert.equal(
    readUserIdFromInitData(
      'query_id=q1&user=%7B%22id%22%3A67890%2C%22first_name%22%3A%22Max%22%7D&hash=ok',
    ),
    '67890',
  );
});

test('prefers the bridge user id when MAX exposes initDataUnsafe', () => {
  assignWindow('https://maxim.play-team.ru/app/?init_data=query-hash%3Dnew', {
    WebApp: {
      initDataUnsafe: {
        user: {
          id: 4321,
        },
      },
    },
  });

  assert.equal(getInitDataUserId(), '4321');
});

test('observes late bridge initData after initial empty startup', async () => {
  assignWindow('https://maxim.play-team.ru/app/');

  let observedValue = '';
  const updatePromise = new Promise<string>((resolve) => {
    const stop = waitForInitData(
      (nextInitData) => {
        observedValue = nextInitData;
        stop();
        resolve(nextInitData);
      },
      5,
      100,
    );
  });

  globalThis.setTimeout(() => {
    const windowLike = globalThis.window as MutableWindow;
    windowLike.WebApp = {
      initData: 'bridge-hash=late',
    };
  }, 15);

  const nextInitData = await updatePromise;

  assert.equal(nextInitData, 'bridge-hash=late');
  assert.equal(observedValue, 'bridge-hash=late');
  assert.equal(getInitData(), 'bridge-hash=late');
});
