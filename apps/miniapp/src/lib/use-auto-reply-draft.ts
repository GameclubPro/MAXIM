import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  areAutoReplyDraftsEqual,
  type AutoReplyDraft,
} from '../pages/publisher-auto-replies-page-model';
import { clearAutoReplyDraft, loadAutoReplyDraft, saveAutoReplyDraft } from './auto-reply-draft';

const AUTO_REPLY_DRAFT_SAVE_DELAY_MS = 250;

export function useAutoReplyDraft({
  chatId,
  ruleId,
  initialDraft,
}: {
  chatId: string;
  ruleId?: string | null;
  initialDraft: AutoReplyDraft;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [baseline, setBaseline] = useState(initialDraft);
  const [hydrated, setHydrated] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let cancelled = false;
    setDraft(initialDraft);
    setBaseline(initialDraft);
    setHydrated(false);

    void loadAutoReplyDraft(chatId, ruleId).then((storedDraft) => {
      if (cancelled) {
        return;
      }
      if (storedDraft) {
        setDraft(storedDraft);
      }
      setHydrated(true);
    });

    return () => {
      cancelled = true;
    };
  }, [chatId, initialDraft, ruleId]);

  const dirty = useMemo(
    () => hydrated && !areAutoReplyDraftsEqual(draft, baseline),
    [baseline, draft, hydrated],
  );

  useEffect(() => {
    if (!hydrated || !dirty) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      saveAutoReplyDraft(chatId, ruleId, draft);
    }, AUTO_REPLY_DRAFT_SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [chatId, dirty, draft, hydrated, ruleId]);

  const discard = useCallback(async () => {
    setDraft(baseline);
    await clearAutoReplyDraft(chatId, ruleId);
  }, [baseline, chatId, ruleId]);

  const persist = useCallback(() => {
    saveAutoReplyDraft(chatId, ruleId, draftRef.current);
  }, [chatId, ruleId]);

  const markSaved = useCallback(
    async (savedDraft: AutoReplyDraft = draftRef.current) => {
      setDraft(savedDraft);
      setBaseline(savedDraft);
      await clearAutoReplyDraft(chatId, ruleId);
    },
    [chatId, ruleId],
  );

  return {
    draft,
    setDraft,
    hydrated,
    dirty,
    persist,
    discard,
    markSaved,
  };
}
