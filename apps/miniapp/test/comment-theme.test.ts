import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMENT_THEMES,
  COMMENT_THEME_STORAGE_KEY,
  hydrateCommentTheme,
  parseCommentTheme,
  readCommentTheme,
  saveCommentTheme,
} from '../src/lib/comment-theme';

function installStorage(nativeGet?: () => Promise<{ value: string | null }>) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const local = new Map<string, string>();
  const native = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => local.set(key, value),
      },
      WebApp: {
        initData: 'preview-test',
        DeviceStorage: {
          getItem: nativeGet ?? (async (key: string) => ({ value: native.get(key) ?? null })),
          setItem: async (key: string, value: string) => {
            native.set(key, value);
          },
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { documentElement: { dataset: { maxClient: 'native' } } },
  });
  return {
    local,
    native,
    restore() {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
      Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: previousDocument,
      });
    },
  };
}

test('comment themes accept only the six shipped theme identifiers', () => {
  assert.deepEqual(
    COMMENT_THEMES.map((theme) => theme.id),
    ['atlas', 'chrome', 'sketch', 'neon', 'obsidian', 'avant'],
  );
  for (const theme of COMMENT_THEMES) assert.equal(parseCommentTheme(theme.id), theme.id);
  for (const invalid of [null, undefined, '', 'dark', 'ATLAS', 'url(https://example.com)', {}, 1]) {
    assert.equal(parseCommentTheme(invalid), null);
  }
});

test('Atlas is the default and selections persist in both device stores', async () => {
  const storage = installStorage();
  try {
    assert.equal(readCommentTheme(), 'atlas');
    await saveCommentTheme('sketch');
    assert.equal(readCommentTheme(), 'sketch');
    assert.equal(storage.local.get(COMMENT_THEME_STORAGE_KEY), 'sketch');
    assert.equal(storage.native.get(COMMENT_THEME_STORAGE_KEY), 'sketch');
    assert.equal(await hydrateCommentTheme(), 'sketch');
  } finally {
    storage.restore();
  }
});

test('native-only preferences hydrate the local mirror', async () => {
  const storage = installStorage();
  try {
    storage.native.set(COMMENT_THEME_STORAGE_KEY, 'chrome');
    assert.equal(await hydrateCommentTheme(), 'chrome');
    assert.equal(readCommentTheme(), 'chrome');
  } finally {
    storage.restore();
  }
});

test('an invalid native preference cannot replace a valid local preference', async () => {
  const storage = installStorage();
  try {
    storage.native.set(COMMENT_THEME_STORAGE_KEY, 'legacy-unknown');
    storage.local.set(COMMENT_THEME_STORAGE_KEY, 'sketch');
    assert.equal(await hydrateCommentTheme(), 'sketch');
    assert.equal(storage.native.get(COMMENT_THEME_STORAGE_KEY), 'sketch');
  } finally {
    storage.restore();
  }
});

test('the latest local choice wins over an older native backup after reopening', async () => {
  const storage = installStorage();
  try {
    storage.local.set(COMMENT_THEME_STORAGE_KEY, 'obsidian');
    storage.native.set(COMMENT_THEME_STORAGE_KEY, 'neon');
    assert.equal(await hydrateCommentTheme(), 'obsidian');
    assert.equal(storage.native.get(COMMENT_THEME_STORAGE_KEY), 'obsidian');
  } finally {
    storage.restore();
  }
});

test('late native reads cannot roll back a new user selection', async () => {
  let release!: (value: { value: string }) => void;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve;
  });
  const storage = installStorage(
    () =>
      new Promise((resolve) => {
        release = resolve;
        markReadStarted();
      }),
  );
  try {
    const pending = hydrateCommentTheme();
    await readStarted;
    await saveCommentTheme('sketch');
    release({ value: 'chrome' });
    assert.equal(await pending, 'sketch');
    assert.equal(readCommentTheme(), 'sketch');
    assert.equal(storage.native.get(COMMENT_THEME_STORAGE_KEY), 'sketch');
  } finally {
    storage.restore();
  }
});

test('aborted hydration leaves the current local selection untouched', async () => {
  const storage = installStorage();
  try {
    storage.local.set(COMMENT_THEME_STORAGE_KEY, 'sketch');
    storage.native.set(COMMENT_THEME_STORAGE_KEY, 'chrome');
    assert.equal(await hydrateCommentTheme(AbortSignal.abort()), 'sketch');
    assert.equal(readCommentTheme(), 'sketch');
  } finally {
    storage.restore();
  }
});

test('restricted WebView storage does not prevent changing the appearance', async () => {
  const storage = installStorage(async () => {
    throw new Error('restricted');
  });
  try {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('restricted');
      },
    });
    assert.equal(readCommentTheme(), 'atlas');
    await assert.doesNotReject(saveCommentTheme('chrome'));
    assert.equal(await hydrateCommentTheme(), 'atlas');
  } finally {
    storage.restore();
  }
});

test('rapid selections serialize native writes while updating the local mirror immediately', async () => {
  const storage = installStorage();
  let release!: () => void;
  const writes: string[] = [];
  window.WebApp!.DeviceStorage!.setItem = async (key, value) => {
    writes.push(value);
    if (value === 'neon')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    storage.native.set(key, value);
    return { status: 'ok' };
  };
  try {
    const first = saveCommentTheme('neon');
    const second = saveCommentTheme('obsidian');
    assert.equal(readCommentTheme(), 'obsidian');
    await Promise.resolve();
    assert.deepEqual(writes, ['neon']);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(writes, ['neon', 'obsidian']);
    assert.equal(storage.native.get(COMMENT_THEME_STORAGE_KEY), 'obsidian');
  } finally {
    storage.restore();
  }
});

test('hydration waits for an already pending native selection before reading it', async () => {
  const storage = installStorage();
  let release!: () => void;
  let writes = 0;
  window.WebApp!.DeviceStorage!.setItem = async (key, value) => {
    if (writes++ === 0) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    storage.native.set(key, value);
    return { status: 'ok' };
  };
  try {
    storage.native.set(COMMENT_THEME_STORAGE_KEY, 'chrome');
    const write = saveCommentTheme('neon');
    await Promise.resolve();
    const hydration = hydrateCommentTheme();
    release();
    await write;
    assert.equal(await hydration, 'neon');
    assert.equal(readCommentTheme(), 'neon');
  } finally {
    storage.restore();
  }
});
