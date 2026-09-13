import {
  readLocalMirrorItem,
  readNativeStorageItem,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from './native-storage';

export const COMMENT_THEMES = [
  { id: 'atlas', label: 'Атлас' },
  { id: 'chrome', label: 'Хром' },
  { id: 'sketch', label: 'Скетч' },
  { id: 'neon', label: 'Неон' },
  { id: 'obsidian', label: 'Обсидиан' },
  { id: 'avant', label: 'Авангард' },
] as const;

export type CommentTheme = (typeof COMMENT_THEMES)[number]['id'];
export const DEFAULT_COMMENT_THEME: CommentTheme = 'atlas';
export const COMMENT_THEME_STORAGE_KEY = 'maxim:comments:theme:v1';
let selectionRevision = 0;
let nativeWrites: Promise<void> = Promise.resolve();

export function parseCommentTheme(value: unknown): CommentTheme | null {
  return COMMENT_THEMES.find((theme) => theme.id === value)?.id ?? null;
}

export function readCommentTheme(): CommentTheme {
  return parseCommentTheme(readLocalMirrorItem(COMMENT_THEME_STORAGE_KEY)) ?? DEFAULT_COMMENT_THEME;
}

export function saveCommentTheme(theme: CommentTheme): Promise<void> {
  if (!parseCommentTheme(theme)) return Promise.resolve();
  selectionRevision += 1;
  writeLocalMirrorItem(COMMENT_THEME_STORAGE_KEY, theme);
  return mirrorCommentTheme(theme);
}

function mirrorCommentTheme(theme: CommentTheme): Promise<void> {
  // FLAG: Native writes are ordered so rapid selections cannot persist an older theme last.
  nativeWrites = nativeWrites.then(() => writeNativeStorageItem(COMMENT_THEME_STORAGE_KEY, theme));
  return nativeWrites;
}

export async function hydrateCommentTheme(signal?: AbortSignal): Promise<CommentTheme> {
  const revision = selectionRevision;
  const runtime = await import('./native-storage-runtime').catch(() => null);
  if (!runtime || signal?.aborted) return readCommentTheme();
  const available = await runtime.waitForNativeStorageRuntime({ signal });
  if (!available || signal?.aborted) return readCommentTheme();
  await nativeWrites;
  if (signal?.aborted || revision !== selectionRevision) return readCommentTheme();
  // FLAG: Keep the local write-ahead choice when a WebView closed before its native write finished.
  const localTheme = parseCommentTheme(readLocalMirrorItem(COMMENT_THEME_STORAGE_KEY));
  if (localTheme) {
    await mirrorCommentTheme(localTheme);
    return readCommentTheme();
  }
  const nativeTheme = parseCommentTheme(await readNativeStorageItem(COMMENT_THEME_STORAGE_KEY));
  // FLAG: Late native reads must not replace a theme selected while the bridge was loading.
  if (signal?.aborted || revision !== selectionRevision) return readCommentTheme();
  if (nativeTheme) {
    writeLocalMirrorItem(COMMENT_THEME_STORAGE_KEY, nativeTheme);
    return nativeTheme;
  }
  return DEFAULT_COMMENT_THEME;
}
