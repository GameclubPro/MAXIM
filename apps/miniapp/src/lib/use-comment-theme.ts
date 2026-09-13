import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hydrateCommentTheme,
  readCommentTheme,
  saveCommentTheme,
  type CommentTheme,
} from './comment-theme';

export function useCommentTheme(enabled: boolean) {
  const [theme, setTheme] = useState(readCommentTheme);
  const selectionRevision = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const revision = selectionRevision.current;
    void hydrateCommentTheme(controller.signal).then((value) => {
      if (!controller.signal.aborted && selectionRevision.current === revision) setTheme(value);
    });
    return () => controller.abort();
  }, [enabled]);
  const selectTheme = useCallback((value: CommentTheme) => {
    selectionRevision.current += 1;
    void saveCommentTheme(value);
    setTheme(value);
  }, []);
  return { theme, selectTheme };
}
