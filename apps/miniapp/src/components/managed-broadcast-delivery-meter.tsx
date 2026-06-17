import type { CSSProperties } from 'react';
import type { ManagedBroadcastSummary } from '@maxim/contracts';
import { cn } from '../lib/cn';
import './managed-broadcast-delivery-meter.css';

type ManagedBroadcastDeliveryMeterProps = {
  broadcast: Pick<
    ManagedBroadcastSummary,
    | 'targetChats'
    | 'deliveredChats'
    | 'failedChats'
    | 'pendingChats'
    | 'blockedChats'
    | 'status'
    | 'failureBreakdown'
  >;
};

export function ManagedBroadcastDeliveryMeter({ broadcast }: ManagedBroadcastDeliveryMeterProps) {
  const targetChats = Math.max(1, broadcast.targetChats);
  const delivered = Math.max(0, Math.min(broadcast.deliveredChats, targetChats));
  const blocked = Math.max(0, Math.min(broadcast.blockedChats, targetChats - delivered));
  const failed = Math.max(
    0,
    Math.min(broadcast.failedChats + blocked, Math.max(0, targetChats - delivered)),
  );
  const pending = Math.max(
    0,
    Math.min(broadcast.pendingChats, Math.max(0, targetChats - delivered - failed)),
  );
  const deliveredPercent = (delivered / targetChats) * 100;
  const failedPercent = (failed / targetChats) * 100;
  const pendingPercent = Math.max(0, 100 - deliveredPercent - failedPercent);
  const visualPendingPercent = pending > 0 ? Math.max(pendingPercent, 4) : pendingPercent;
  const style = {
    '--managed-broadcast-delivered': `${deliveredPercent}%`,
    '--managed-broadcast-failed': `${failedPercent}%`,
    '--managed-broadcast-pending': `${visualPendingPercent}%`,
  } as CSSProperties;

  return (
    <div
      className={cn(
        'managed-broadcast-delivery-meter',
        broadcast.status === 'FAILED' && 'is-failed',
        broadcast.status === 'PARTIAL' && 'is-partial',
      )}
      aria-label={`Доставлено ${delivered} из ${targetChats}, ошибок ${failed}, в очереди ${pending}`}
    >
      <span className="managed-broadcast-delivery-meter__rail" style={style} aria-hidden>
        <span className="managed-broadcast-delivery-meter__segment is-delivered" />
        <span className="managed-broadcast-delivery-meter__segment is-failed" />
        <span className="managed-broadcast-delivery-meter__segment is-pending" />
      </span>
      <span className="managed-broadcast-delivery-meter__meta">
        <strong>
          {delivered}/{targetChats}
        </strong>
        {blocked > 0 ? (
          <small>{blocked} исключ.</small>
        ) : failed > 0 ? (
          <small>{failed} ошибок</small>
        ) : pending > 0 ? (
          <small>{pending} ждёт</small>
        ) : null}
      </span>
      {failed > 0 || blocked > 0 ? (
        <span className="managed-broadcast-delivery-meter__breakdown" aria-hidden>
          {broadcast.failureBreakdown.permanentTarget > 0 ? (
            <span>{broadcast.failureBreakdown.permanentTarget} недост.</span>
          ) : null}
          {broadcast.failureBreakdown.transient > 0 ? (
            <span>{broadcast.failureBreakdown.transient} повтор</span>
          ) : null}
          {broadcast.failureBreakdown.quarantined > 0 ? (
            <span>{broadcast.failureBreakdown.quarantined} стоп</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

export default ManagedBroadcastDeliveryMeter;
