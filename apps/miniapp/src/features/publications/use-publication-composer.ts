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
  flushPublicationDraftStorage,
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
  imagesNeedReselection: boolean;
  persistencePending: boolean;
  clearDraft: (targets?: PublicationTarget[]) => Promise<void>;
  discardMissingImages: () => void;
  resolveMissingImages: () => void;
  flushDraft: () => Promise<void>;
};

export function usePublicationComposer(
  editorOpen: boolean,
  persistenceEnabled = true,
  enabled = true,
  pendingWork = false,
  userId: string | null = null,
): PublicationComposerState {
  const [draft, setDraft] = useState<PublicationDraft>(() => createEmptyPublicationDraft());
  const [hydrated, setHydrated] = useState(false);
  const [hasSavedDraft, setHasSavedDraft] = useState(false);
  const [imagesNeedReselection, setImagesNeedReselection] = useState(false);
  const [persistencePending, setPersistencePending] = useState(false);
  const saveTimerRef = useRef<number | null>(null);
  const persistenceOperationRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const draftRef = useRef(draft);
  const imagesNeedReselectionRef = useRef(imagesNeedReselection);
  const hydratedRef = useRef(hydrated);
  const persistenceEnabledRef = useRef(persistenceEnabled);
  const normalizedUserId = enabled ? userId?.trim() || null : null;

  draftRef.current = draft;
  imagesNeedReselectionRef.current = imagesNeedReselection;
  hydratedRef.current = hydrated;
  persistenceEnabledRef.current = persistenceEnabled;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const trackPersistence = useCallback((operation: Promise<void>): Promise<void> => {
    const tracked = operation.catch(() => undefined);
    persistenceOperationRef.current = tracked;
    if (mountedRef.current) {
      setPersistencePending(true);
    }
    void tracked.finally(() => {
      if (mountedRef.current && persistenceOperationRef.current === tracked) {
        setPersistencePending(false);
      }
    });
    return tracked;
  }, []);

  const persistSnapshot = useCallback(
    (snapshot: PublicationDraft, missingImages: boolean): Promise<void> => {
      if (!normalizedUserId) {
        return Promise.resolve();
      }
      const hasDraft = missingImages || !isPublicationDraftEmpty(snapshot);
      if (mountedRef.current) {
        setHasSavedDraft(hasDraft);
      }
      return trackPersistence(
        hasDraft
          ? savePublicationDraft(snapshot, normalizedUserId, {
              imagesNeedReselection: missingImages,
            })
          : clearPublicationDraft(normalizedUserId),
      );
    },
    [normalizedUserId, trackPersistence],
  );

  const flushDraft = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (normalizedUserId && hydratedRef.current && persistenceEnabledRef.current) {
      await persistSnapshot(draftRef.current, imagesNeedReselectionRef.current);
    }
    await persistenceOperationRef.current;
    if (normalizedUserId) {
      await flushPublicationDraftStorage(normalizedUserId);
    }
  }, [normalizedUserId, persistSnapshot]);

  useEffect(() => {
    if (!enabled || !normalizedUserId) {
      setDraft(createEmptyPublicationDraft());
      setImagesNeedReselection(false);
      setHasSavedDraft(false);
      setHydrated(true);
      return undefined;
    }

    setDraft(createEmptyPublicationDraft());
    setImagesNeedReselection(false);
    setHasSavedDraft(false);
    setHydrated(false);
    let cancelled = false;
    void loadPublicationDraft(normalizedUserId)
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (stored.draft) {
          setDraft(stored.draft);
          setImagesNeedReselection(stored.imagesNeedReselection);
          setHasSavedDraft(stored.imagesNeedReselection || !isPublicationDraftEmpty(stored.draft));
        }
        setHydrated(true);
      })
      .catch(() => {
        if (!cancelled) {
          setHydrated(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, normalizedUserId]);

  useEffect(() => {
    if (!enabled || !normalizedUserId || !hydrated || !persistenceEnabled) {
      return undefined;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void persistSnapshot(draft, imagesNeedReselection);
    }, 350);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    draft,
    enabled,
    hydrated,
    imagesNeedReselection,
    normalizedUserId,
    persistenceEnabled,
    persistSnapshot,
  ]);

  useEffect(() => {
    if (!enabled || !normalizedUserId) {
      return undefined;
    }
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') {
        void flushDraft();
      }
    };
    const flushOnPageHide = () => {
      void flushDraft();
    };
    document.addEventListener('visibilitychange', flushWhenHidden);
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      document.removeEventListener('visibilitychange', flushWhenHidden);
      window.removeEventListener('pagehide', flushOnPageHide);
    };
  }, [enabled, flushDraft, normalizedUserId]);

  const hasDraft = imagesNeedReselection || !isPublicationDraftEmpty(draft);
  const shouldProtectClose =
    enabled && ((editorOpen && (pendingWork || hasDraft)) || persistencePending);
  useEffect(() => {
    setMaxClosingConfirmation(shouldProtectClose);
    if (!shouldProtectClose) {
      return undefined;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      void flushDraft();
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      setMaxClosingConfirmation(false);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [flushDraft, shouldProtectClose]);

  const clearDraft = useCallback(
    async (targets: PublicationTarget[] = []) => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setDraft(createEmptyPublicationDraft(targets));
      setImagesNeedReselection(false);
      setHasSavedDraft(false);
      if (normalizedUserId) {
        await trackPersistence(clearPublicationDraft(normalizedUserId));
      }
    },
    [normalizedUserId, trackPersistence],
  );

  const discardMissingImages = useCallback(() => {
    setImagesNeedReselection(false);
  }, []);

  const resolveMissingImages = useCallback(() => {
    setImagesNeedReselection(false);
  }, []);

  return {
    draft,
    setDraft,
    hydrated,
    hasSavedDraft,
    imagesNeedReselection,
    persistencePending,
    clearDraft,
    discardMissingImages,
    resolveMissingImages,
    flushDraft,
  };
}
