import { useMemo, useState } from 'react';
import type { RollbackVkParsingRequest, VkParsingFeed, VkParsingSource } from '@maxim/contracts';

type SafetyPanelProps = {
  sources: VkParsingSource[];
  auditEvents: VkParsingFeed['auditEvents'];
  isRollingBack: boolean;
  onRollback: (payload: RollbackVkParsingRequest) => void;
};

function toDatetimeLocal(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

function formatAuditAction(action: string): string {
  return action.replace(/^VK_PARSING_/u, '').replaceAll('_', ' ');
}

export function SafetyPanel({ sources, auditEvents, isRollingBack, onRollback }: SafetyPanelProps) {
  const defaults = useMemo(() => {
    const until = new Date();
    const since = new Date(until.getTime() - 2 * 60 * 60_000);
    return { since: toDatetimeLocal(since), until: toDatetimeLocal(until) };
  }, []);
  const [since, setSince] = useState(defaults.since);
  const [until, setUntil] = useState(defaults.until);
  const [sourceId, setSourceId] = useState('');
  const [deleteMessages, setDeleteMessages] = useState(false);

  return (
    <section className="vk-safety-panel" aria-label="Безопасность">
      <div className="vk-rollback-form">
        <input
          type="datetime-local"
          value={since}
          onChange={(event) => setSince(event.target.value)}
        />
        <input
          type="datetime-local"
          value={until}
          onChange={(event) => setUntil(event.target.value)}
        />
        <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
          <option value="">Все</option>
          {sources.map((source) => (
            <option key={source.id} value={source.id}>
              {source.title}
            </option>
          ))}
        </select>
        <label className="vk-source-toggle">
          <span>Удалить</span>
          <input
            type="checkbox"
            checked={deleteMessages}
            onChange={(event) => setDeleteMessages(event.target.checked)}
          />
        </label>
        <button
          type="button"
          className="vk-source-preset"
          disabled={isRollingBack}
          onClick={() =>
            onRollback({
              since: fromDatetimeLocal(since),
              until: fromDatetimeLocal(until),
              ...(sourceId ? { sourceId } : {}),
              deleteMessages,
            })
          }
        >
          Откат
        </button>
      </div>

      {auditEvents.length > 0 ? (
        <div className="vk-audit-list">
          {auditEvents.slice(0, 6).map((event) => (
            <span key={event.id} title={event.actorUserId}>
              {formatAuditAction(event.action)}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
