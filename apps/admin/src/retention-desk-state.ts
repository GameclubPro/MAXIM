import type {
  SafetyDeskRetentionPreviewItem,
  SafetyDeskRetentionPreviewResponse,
  SafetyDeskRetentionRuntimeItem,
  SafetyDeskRetentionRuntimeResponse,
} from '@maxim/contracts/safety-desk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApiError } from './api-response';
import { safetyDeskApiClient } from './safety-desk-api-client';
import { buildRetentionRetryRequest, readErrorMessage } from './safety-desk-model';

export type RetentionDeskProps = {
  accessCode: string;
  refreshToken: number;
  onSnapshot: (snapshot: SafetyDeskRetentionRuntimeResponse) => void;
  onBusyChange: (busy: boolean) => void;
};

export function useRetentionDeskControls() {
  const [runtime, onSnapshot] = useState<SafetyDeskRetentionRuntimeResponse | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, onBusyChange] = useState(false);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  return { runtime, refreshToken, busy, onSnapshot, onBusyChange, refresh };
}
export type RetentionDeskControls = ReturnType<typeof useRetentionDeskControls>;

type RetentionPage = { after: string | null; trail: Array<string | null> };

export function useRetentionDesk({
  accessCode,
  refreshToken,
  onSnapshot,
  onBusyChange,
}: RetentionDeskProps) {
  const [runtime, setRuntime] = useState<SafetyDeskRetentionRuntimeResponse | null>(null);
  const [selected, setSelected] = useState<SafetyDeskRetentionRuntimeItem | null>(null);
  const [preview, setPreview] = useState<SafetyDeskRetentionPreviewResponse | null>(null);
  const [pageAfter, setPageAfter] = useState<string | null>(null);
  const [trail, setTrail] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [busyMessageId, setBusyMessageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState('');
  const [previewNotice, setPreviewNotice] = useState('');
  const pageSequence = useRef(0);
  const previewSequence = useRef(0);
  const currentPage = useRef<RetentionPage>({ after: null, trail: [] });
  const requestedPage = useRef<RetentionPage>({ after: null, trail: [] });
  const mutationActive = useRef(false);
  const active = useRef(false);
  const mutationSequence = useRef(0);
  const currentRecord = useRef<{
    selected: SafetyDeskRetentionRuntimeItem | null;
    preview: SafetyDeskRetentionPreviewResponse | null;
  }>({ selected: null, preview: null });

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      ++mutationSequence.current;
      currentRecord.current = { selected: null, preview: null };
      if (mutationActive.current) {
        mutationActive.current = false;
        onBusyChange(false);
      }
    };
  }, [onBusyChange]);

  const loadPage = useCallback(
    async (after: string | null, nextTrail = currentPage.current.trail) => {
      if (!active.current || mutationActive.current) return false;
      const request = { after, trail: nextTrail };
      requestedPage.current = request;
      const sequence = ++pageSequence.current;
      ++previewSequence.current;
      currentRecord.current = { selected: null, preview: null };
      setLoading(true);
      setPageError('');
      setSelected(null);
      setPreview(null);
      setPreviewNotice('');
      setPreviewLoading(false);
      try {
        const response = await safetyDeskApiClient.fetchRetentionRuntime(accessCode, after);
        if (sequence !== pageSequence.current) return false;
        currentPage.current = request;
        setPageAfter(after);
        setTrail(request.trail);
        setRuntime(response);
        onSnapshot(response);
        return true;
      } catch (error) {
        if (sequence === pageSequence.current) {
          setPageError(readErrorMessage(error));
        }
        return false;
      } finally {
        if (sequence === pageSequence.current) setLoading(false);
      }
    },
    [accessCode, onSnapshot],
  );

  useEffect(() => {
    void loadPage(currentPage.current.after, currentPage.current.trail);
    return () => {
      ++pageSequence.current;
      ++previewSequence.current;
    };
  }, [loadPage, refreshToken]);

  async function loadPreview(item: SafetyDeskRetentionRuntimeItem) {
    if (!active.current || mutationActive.current) return;
    const sequence = ++previewSequence.current;
    currentRecord.current = { selected: item, preview: null };
    setSelected(item);
    setPreview(null);
    setPreviewNotice('');
    setPreviewLoading(true);
    try {
      const response = await safetyDeskApiClient.fetchRetentionPreview(item.chatId, accessCode);
      if (sequence === previewSequence.current) {
        currentRecord.current.preview = response;
        setPreview(response);
      }
    } catch (error) {
      if (sequence === previewSequence.current) setPreviewNotice(readErrorMessage(error));
    } finally {
      if (sequence === previewSequence.current) setPreviewLoading(false);
    }
  }

  async function retry(item: SafetyDeskRetentionPreviewItem) {
    const record = currentRecord.current;
    if (!active.current || !record.selected?.enabled || !record.preview || mutationActive.current)
      return;
    const currentItem = record.preview.items.find(
      (candidate) => candidate.messageId === item.messageId,
    );
    if (!currentItem) return;
    const request = buildRetentionRetryRequest(record.preview, currentItem);
    if (!request || record.preview.chatId !== record.selected.chatId) return;
    const chatId = record.selected.chatId;
    if (
      !window.confirm(
        `Вернуть сообщение ${item.messageId} в очередь очистки? Сервер повторно проверит срок, права и состояние. Удаление необратимо.`,
      )
    )
      return;
    mutationActive.current = true;
    const sequence = ++mutationSequence.current;
    const isCurrent = () => active.current && sequence === mutationSequence.current;
    onBusyChange(true);
    setBusyMessageId(item.messageId);
    setPreviewNotice('Возвращаю сообщение в очередь…');
    try {
      const response = await safetyDeskApiClient.retryRetention(chatId, request, accessCode);
      if (!isCurrent()) return;
      currentRecord.current.preview = response;
      setPreview(response);
      setPreviewNotice('Сообщение возвращено в очередь. Результат проверит фоновая очистка.');
    } catch (error) {
      if (!isCurrent()) return;
      // FLAG: clear stale action permissions before reconciling an uncertain or rejected retry.
      currentRecord.current.preview = null;
      setPreview(null);
      const message =
        error instanceof AdminApiError && error.status === 409
          ? `Повтор отклонён: ${readErrorMessage(error).replace(/[.!?]+$/u, '')}. Обновляю диагностику…`
          : `${readErrorMessage(error)} Проверяю состояние очереди…`;
      setPreviewNotice(message);
      try {
        const response = await safetyDeskApiClient.fetchRetentionPreview(chatId, accessCode);
        if (!isCurrent()) return;
        currentRecord.current.preview = response;
        setPreview(response);
        if (error instanceof AdminApiError && error.status === 409) {
          setPreviewNotice(
            `Повтор отклонён: ${readErrorMessage(error).replace(/[.!?]+$/u, '')}. Диагностика обновлена; проверьте запись перед повтором.`,
          );
        } else {
          setPreviewNotice(
            `${readErrorMessage(error)} Состояние очереди обновлено; проверьте запись перед повтором.`,
          );
        }
      } catch (refreshError) {
        if (!isCurrent()) return;
        setPreviewNotice(
          `${readErrorMessage(error)} Не удалось проверить состояние: ${readErrorMessage(refreshError)} Обновите диагностику перед повтором.`,
        );
      }
    } finally {
      // FLAG: an old unmounted operation must not release a newer desk's mutation lock.
      if (isCurrent()) {
        setBusyMessageId(null);
        mutationActive.current = false;
        onBusyChange(false);
      }
    }
  }

  async function nextPage() {
    if (!runtime?.nextAfter || loading) return;
    await loadPage(runtime.nextAfter, [...trail, pageAfter]);
  }

  async function previousPage() {
    if (!trail.length || loading) return;
    await loadPage(trail[trail.length - 1] ?? null, trail.slice(0, -1));
  }

  async function retryPage() {
    const request = requestedPage.current;
    await loadPage(request.after, request.trail);
  }

  return {
    runtime,
    selected,
    preview,
    pageAfter,
    trail,
    loading,
    previewLoading,
    busyMessageId,
    pageError,
    previewNotice,
    loadPage,
    retryPage,
    loadPreview,
    retry,
    nextPage,
    previousPage,
  };
}
