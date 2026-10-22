import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../../lib/api/transport';
import {
  hydrateNetworkSettingsOperationReceipts,
  hasUnsettledNetworkSettingsRetry,
  persistNetworkSettingsOperationReceipt,
  removeNetworkSettingsOperationReceipt,
  type NetworkSettingsOperationReceipt,
} from '../../lib/network-settings-operation-storage';
import { hydrateNetworkSettingsScope } from '../../lib/network-settings-workspace-state';
import {
  isNetworkSettingsOperationSettled,
  readVerifiedNetworkSettingsOperation,
  networkSettingsReceiptForStatus,
} from '../network-settings/network-settings-controller';
import { getNetworkSettingsSectionPresentation } from '../../pages/settings/settings-workspace-sections';

const labels: Record<string, string> = {
  PREVIEWING: 'Проверка изменений',
  PREPARED: 'Ожидает подтверждения',
  AUTHORIZING: 'Проверяем доступ',
  RUNNING: 'Применяется',
  COMPLETE: 'Готово',
  PARTIAL: 'Есть неприменённые изменения',
  FAILED: 'Не применено',
};
export function NetworkOperationHistory({ api, userId }: { api: ApiTransport; userId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = useState(
    () => new URLSearchParams(location.search).get('history') === '1',
  );
  const [receipts, setReceipts] = useState<NetworkSettingsOperationReceipt[]>([]);
  const [limit, setLimit] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<NetworkSettingsOperationResponse | null>(null);
  useEffect(() => {
    let active = true;
    void hydrateNetworkSettingsOperationReceipts(userId)
      .then((value) => {
        if (active) setReceipts(value);
      })
      .catch(() => {
        if (active) setError('Не удалось прочитать историю. Откройте раздел заново.');
      });
    return () => {
      active = false;
    };
  }, [userId]);
  const inspect = async (receipt: NetworkSettingsOperationReceipt) => {
    setBusy(receipt.operationId);
    setError(null);
    setResult(null);
    try {
      const operation = await readVerifiedNetworkSettingsOperation(api, {
        ...receipt,
        recipientIds: receipt.recipientIds,
      });
      const updated = networkSettingsReceiptForStatus(receipt, operation);
      await persistNetworkSettingsOperationReceipt(updated);
      setReceipts(await hydrateNetworkSettingsOperationReceipts(userId));
      setResult(operation);
    } catch {
      setError('Не удалось проверить результат. Повторите попытку.');
    } finally {
      setBusy(null);
    }
  };
  const open = async (receipt: NetworkSettingsOperationReceipt) => {
    try {
      const scope = await hydrateNetworkSettingsScope({
        userId,
        scopeId: receipt.scopeId,
        entityType: receipt.entityType,
      });
      if (!scope) {
        await inspect(receipt);
        return;
      }
      navigate(
        `/networks/${receipt.entityType}/settings/${receipt.section}?${new URLSearchParams({ scope: receipt.scopeId, operation: receipt.operationId })}`,
      );
    } catch {
      setError('Не удалось открыть операцию. Проверьте её результат здесь.');
    }
  };
  const archive = async (receipt: NetworkSettingsOperationReceipt) => {
    if (hasUnsettledNetworkSettingsRetry(receipt.operationId, receipts)) {
      setError(
        'Сначала завершите повторную операцию или уберите её неподтверждённую проверку из истории.',
      );
      return;
    }
    if (
      !result ||
      result.operationId !== receipt.operationId ||
      !(
        isNetworkSettingsOperationSettled(result) ||
        (result.status === 'PREPARED' && receipt.launchState === 'unconfirmed')
      )
    )
      return;
    setBusy(receipt.operationId);
    try {
      await removeNetworkSettingsOperationReceipt(userId, receipt.operationId);
      setReceipts(await hydrateNetworkSettingsOperationReceipts(userId));
      setResult(null);
    } catch {
      setError('Не удалось убрать запись из истории. Результат сохранён.');
    } finally {
      setBusy(null);
    }
  };
  const active = receipts.filter(
    (receipt) =>
      !receipt.settlementConfirmedAt &&
      !receipt.completionConfirmedAt &&
      receipt.launchState !== 'unconfirmed',
  );
  if (!receipts.length && !error && !expanded) return null;
  return (
    <div>
      {active.length ? (
        <button
          className="network-history-active networks-secondary"
          type="button"
          onClick={() => setExpanded(true)}
        >
          {active.length === 1
            ? `${active[0].title} · ${labels[active[0].lastKnownStatus ?? ''] ?? 'Проверить результат'}`
            : `Незавершённые операции · ${active.length}`}
        </button>
      ) : null}
      <details
        className="networks-resumes"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          Последние изменения <span>{receipts.length}</span>
        </summary>
        {error ? <p role="alert">{error}</p> : null}
        {!receipts.length && !error ? <p>Здесь появятся результаты применения настроек.</p> : null}
        {receipts.slice(0, limit).map((receipt) => (
          <article key={receipt.operationId} className="network-history-entry">
            <strong>
              {receipt.title} · {receipt.entityType === 'chat' ? 'Чаты' : 'Каналы'}
            </strong>
            <span>
              {getNetworkSettingsSectionPresentation(receipt.entityType, receipt.section).title}
            </span>
            <small>
              {new Date(receipt.updatedAt).toLocaleString('ru-RU')} ·{' '}
              {labels[receipt.lastKnownStatus ?? ''] ?? 'Результат требует проверки'}
            </small>
            <div className="network-statistics-actions">
              <button type="button" onClick={() => void open(receipt)}>
                Открыть
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void inspect(receipt)}>
                {busy === receipt.operationId ? 'Проверяем…' : 'Проверить результат'}
              </button>
            </div>
            {result?.operationId === receipt.operationId ? (
              <div role="status">
                <p>
                  {labels[result.status]} · Применено{' '}
                  {result.outcomes.filter((row) => row.status === 'COMPLETE').length} из{' '}
                  {result.outcomes.length}
                </p>
                {isNetworkSettingsOperationSettled(result) ||
                (result.status === 'PREPARED' && receipt.launchState === 'unconfirmed') ? (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void archive(receipt)}
                  >
                    Убрать из истории
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        ))}
        {receipts.length > limit ? (
          <button type="button" onClick={() => setLimit((value) => value + 10)}>
            Показать ещё
          </button>
        ) : null}
      </details>
    </div>
  );
}
