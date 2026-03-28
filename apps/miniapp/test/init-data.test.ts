import assert from 'node:assert/strict';
import test from 'node:test';
import { getInitData } from '../src/lib/init-data';

type MutableWindow = Window &
  typeof globalThis & {
    WebApp?: {
      initData?: string;
      init_data?: string;
    };
    MAX?: {
      WebApp?: {
        initData?: string;
        init_data?: string;
      };
    };
  };

function assignWindow(url: string, overrides: Partial<MutableWindow> = {}): void {
  const windowLike = {
    location: new URL(url),
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
