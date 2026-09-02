import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import {
  areAutoReplyDraftsEqual,
  type AutoReplyDraft,
} from '../pages/publisher-auto-replies-page-model';
import {
  clearAutoReplyDraft,
  loadAutoReplyDraftState,
  saveAutoReplyDraft,
} from './auto-reply-draft';

const AUTO_REPLY_DRAFT_SAVE_DELAY_MS = 250;

export function useAutoReplyDraft({
  userId,
  chatId,
  ruleId,
  initialDraft,
}: {
  userId: string;
  chatId: string;
  ruleId?: string | null;
  initialDraft: AutoReplyDraft;
}) {
  const [draft, setDraftState] = useState(initialDraft);
  const [baseline, setBaseline] = useState(initialDraft);
  const [hydrated, setHydrated] = useState(false);
  const [storageReadError, setStorageReadError] = useState(false);
  const [hydrationRevision, setHydrationRevision] = useState(0);
  const [restoredMissingImageCount, setRestoredMissingImageCount] = useState(0);
  const modifiedSinceHydrationRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setDraft = useCallback((next: SetStateAction<AutoReplyDraft>) => {
    modifiedSinceHydrationRef.current = true;
    setDraftState(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    modifiedSinceHydrationRef.current = false;
    setDraftState(initialDraft);
    setBaseline(initialDraft);
    setRestoredMissingImageCount(0);
    setStorageReadError(false);
    setHydrated(false);

    void loadAutoReplyDraftState(userId, chatId, ruleId)
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (stored.draft) {
          setDraftState(stored.draft);
        }
        setRestoredMissingImageCount(stored.missingImageCount);
        setHydrated(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setStorageReadError(true);
        setHydrated(true);
      });

    return () => {
      cancelled = true;
    };
  }, [chatId, hydrationRevision, initialDraft, ruleId, userId]);

  const dirty = useMemo(
    () => hydrated && !areAutoReplyDraftsEqual(draft, baseline),
    [baseline, draft, hydrated],
  );
  const missingImageCount = Math.max(0, restoredMissingImageCount - draft.images.length);

  useEffect(() => {
    if (restoredMissingImageCount > 0 && draft.images.length >= restoredMissingImageCount) {
      setRestoredMissingImageCount(0);
    }
  }, [draft.images.length, restoredMissingImageCount]);

  useEffect(() => {
    if (
      !hydrated ||
      !dirty ||
      storageReadError ||
      !modifiedSinceHydrationRef.current ||
      missingImageCount > 0
    ) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void saveAutoReplyDraft(userId, chatId, ruleId, draft, { imagesComplete: true });
    }, AUTO_REPLY_DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [chatId, dirty, draft, hydrated, missingImageCount, ruleId, storageReadError, userId]);

  const discard = useCallback(async () => {
    modifiedSinceHydrationRef.current = false;
    setDraftState(baseline);
    setRestoredMissingImageCount(0);
    setStorageReadError(false);
    setHydrated(true);
    await clearAutoReplyDraft(userId, chatId, ruleId);
  }, [baseline, chatId, ruleId, userId]);

  const retryHydration = useCallback(() => {
    setHydrationRevision((current) => current + 1);
  }, []);

  const persist = useCallback(
    (draftOverride?: AutoReplyDraft) => {
      const candidate = draftOverride ?? draftRef.current;
      const overrideChanged =
        draftOverride !== undefined && !areAutoReplyDraftsEqual(candidate, draftRef.current);
      if (!modifiedSinceHydrationRef.current && !overrideChanged) {
        return Promise.resolve();
      }
      if (storageReadError || missingImageCount > 0) {
        return Promise.resolve();
      }
      return saveAutoReplyDraft(userId, chatId, ruleId, candidate, { imagesComplete: true });
    },
    [chatId, missingImageCount, ruleId, storageReadError, userId],
  );

  const markSaved = useCallback(
    async (savedDraft: AutoReplyDraft = draftRef.current) => {
      modifiedSinceHydrationRef.current = false;
      setDraftState(savedDraft);
      setBaseline(savedDraft);
      setRestoredMissingImageCount(0);
      await clearAutoReplyDraft(userId, chatId, ruleId);
    },
    [chatId, ruleId, userId],
  );

  return {
    draft,
    setDraft,
    hydrated,
    dirty,
    missingImageCount,
    storageReadError,
    modifiedSinceHydration: modifiedSinceHydrationRef.current,
    retryHydration,
    persist,
    discard,
    markSaved,
  };
}
