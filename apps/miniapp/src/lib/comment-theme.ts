import {
  readLocalMirrorItem,
  readNativeStorageItem,
  saveMirroredItem,
  writeLocalMirrorItem,
  writeNativeStorageItem,
} from './native-storage';

export const COMMENT_THEMES = [
  { id: 'atlas', label: 'Атлас' },
  { id: 'chrome', label: 'Хром' },
  { id: 'sketch', label: 'Скетч' },
] as const;

export type CommentTheme = (typeof COMMENT_THEMES)[number]['id'];
export const DEFAULT_COMMENT_THEME: CommentTheme = 'atlas';
export const COMMENT_THEME_STORAGE_KEY = 'maxim:comments:theme:v1';
let selectionRevision = 0;

export function parseCommentTheme(value: unknown): CommentTheme | null {
  return COMMENT_THEMES.find((theme) => theme.id === value)?.id ?? null;
}

export function readCommentTheme(): CommentTheme {
  return parseCommentTheme(readLocalMirrorItem(COMMENT_THEME_STORAGE_KEY)) ?? DEFAULT_COMMENT_THEME;
}

export function saveCommentTheme(theme: CommentTheme): void {
  if (!parseCommentTheme(theme)) return;
  selectionRevision += 1;
  saveMirroredItem(COMMENT_THEME_STORAGE_KEY, theme);
}

export async function hydrateCommentTheme(signal?: AbortSignal): Promise<CommentTheme> {
  const revision = selectionRevision;
  const runtime = await import('./native-storage-runtime').catch(() => null);
  if (!runtime || signal?.aborted) return readCommentTheme();
  const available = await runtime.waitForNativeStorageRuntime({ signal });
  if (!available || signal?.aborted) return readCommentTheme();
  const nativeTheme = parseCommentTheme(await readNativeStorageItem(COMMENT_THEME_STORAGE_KEY));
  // FLAG: Late native reads must not replace a theme selected while the bridge was loading.
  if (signal?.aborted || revision !== selectionRevision) return readCommentTheme();
  if (nativeTheme) {
    writeLocalMirrorItem(COMMENT_THEME_STORAGE_KEY, nativeTheme);
    return nativeTheme;
  }
  const localTheme = parseCommentTheme(readLocalMirrorItem(COMMENT_THEME_STORAGE_KEY));
  if (localTheme) void writeNativeStorageItem(COMMENT_THEME_STORAGE_KEY, localTheme);
  return localTheme ?? DEFAULT_COMMENT_THEME;
}
