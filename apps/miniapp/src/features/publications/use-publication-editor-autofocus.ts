import { useEffect, type RefObject } from 'react';

export function usePublicationEditorAutofocus(
  editorOpen: boolean,
  titleRef: RefObject<HTMLHeadingElement | null>,
): void {
  useEffect(() => {
    if (!editorOpen) {
      return undefined;
    }
    const frameId = window.requestAnimationFrame(() =>
      titleRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frameId);
  }, [editorOpen, titleRef]);
}
