import { useCallback, useEffect, useState } from 'react';
import {
  hydrateCommentTheme,
  readCommentTheme,
  saveCommentTheme,
  type CommentTheme,
} from './comment-theme';

export function useCommentTheme(enabled: boolean) {
  const [theme, setTheme] = useState(readCommentTheme);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void hydrateCommentTheme(controller.signal).then((value) => {
      if (!controller.signal.aborted) setTheme(value);
    });
    return () => controller.abort();
  }, [enabled]);
  const selectTheme = useCallback((value: CommentTheme) => {
    saveCommentTheme(value);
    setTheme(value);
  }, []);
  return { theme, selectTheme };
}
