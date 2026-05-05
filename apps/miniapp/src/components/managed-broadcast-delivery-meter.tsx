import type { CSSProperties } from 'react';
import type { ManagedBroadcastSummary } from '@maxim/contracts';
import { cn } from '../lib/cn';

type ManagedBroadcastDeliveryMeterProps = {
  broadcast: Pick<
    ManagedBroadcastSummary,
    'targetChats' | 'deliveredChats' | 'failedChats' | 'pendingChats' | 'blockedChats' | 'status'
  >;
};

export function ManagedBroadcastDeliveryMeter({ broadcast }: ManagedBroadcastDeliveryMeterProps) {
  const targetChats = Math.max(1, broadcast.targetChats);
  const delivered = Math.max(0, Math.min(broadcast.deliveredChats, targetChats));
  const failed = Math.max(
    0,
    Math.min(broadcast.failedChats + broadcast.blockedChats, Math.max(0, targetChats - delivered)),
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
        {failed > 0 ? <small>{failed} ошибок</small> : pending > 0 ? <small>{pending} ждёт</small> : null}
      </span>
    </div>
  );
}

export default ManagedBroadcastDeliveryMeter;
