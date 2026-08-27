import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { setMaxClosingConfirmation } from '../../lib/max-bridge';
import {
  clearPublicationDraft,
  loadPublicationDraft,
  savePublicationDraft,
} from './publication-draft-storage';
import {
  createEmptyPublicationDraft,
  isPublicationDraftEmpty,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';

type PublicationComposerState = {
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  hydrated: boolean;
  hasSavedDraft: boolean;
  clearDraft: (targets?: PublicationTarget[]) => Promise<void>;
};

export function usePublicationComposer(
  editorOpen: boolean,
  persistenceEnabled = true,
  enabled = true,
): PublicationComposerState {
  const [draft, setDraft] = useState<PublicationDraft>(() => createEmptyPublicationDraft());
  const [hydrated, setHydrated] = useState(false);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setHydrated(true);
      return undefined;
    }
    let cancelled = false;
    void loadPublicationDraft().then((stored) => {
      if (cancelled) {
        return;
      }
      if (stored) {
        setDraft(stored);
        setHasSavedDraft(!isPublicationDraftEmpty(stored));
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !hydrated || !persistenceEnabled) {
      return undefined;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      if (isPublicationDraftEmpty(draft)) {
        setHasSavedDraft(false);
        void clearPublicationDraft();
      } else {
        setHasSavedDraft(true);
        void savePublicationDraft(draft);
      }
    }, 350);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [draft, enabled, hydrated, persistenceEnabled]);

  const shouldProtectClose = enabled && editorOpen && !isPublicationDraftEmpty(draft);
  useEffect(() => {
    setMaxClosingConfirmation(shouldProtectClose);
    if (!shouldProtectClose) {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      setMaxClosingConfirmation(false);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [shouldProtectClose]);

  const clearDraft = useCallback(async (targets: PublicationTarget[] = []) => {
    setDraft(createEmptyPublicationDraft(targets));
    setHasSavedDraft(false);
    await clearPublicationDraft();
  }, []);

  return { draft, setDraft, hydrated, hasSavedDraft, clearDraft };
}
