import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import type { ApiTransport } from '../lib/api/transport';
import { AppIcon } from './ui/app-icon';
import type { ManagedEntityBotsSheetProps } from './managed-entity-bots-sheet';
import './managed-entity-bots-control.css';

export type ManagedEntityBotsControlProps = {
  api: ApiTransport;
  userId: string;
  entityType: 'chat' | 'channel';
  entityId: string;
  title: string;
};

function BotsControl(props: ManagedEntityBotsControlProps) {
  const dialogId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [Sheet, setSheet] = useState<ComponentType<ManagedEntityBotsSheetProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const loading = open && !Sheet;
  const label = props.entityType === 'channel' ? 'Боты канала' : 'Боты чата';

  useEffect(() => {
    if (!open || Sheet) return;
    let cancelled = false;
    void import('./managed-entity-bots-sheet')
      .then((module) => {
        if (!cancelled) setSheet(() => module.default);
      })
      .catch(() => {
        if (cancelled) return;
        setOpen(false);
        setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, Sheet]);

  return (
    <div className="managed-entity-bots-control">
      <button
        ref={triggerRef}
        type="button"
        className="managed-entity-bots-control__trigger"
        data-managed-entity-bots-trigger
        aria-label={`${label}: ${props.title}`}
        aria-haspopup="dialog"
        aria-controls={dialogId}
        aria-expanded={open}
        aria-busy={loading}
        disabled={loading}
        onClick={() => {
          setLoadError(false);
          setOpen(true);
        }}
      >
        <AppIcon icon="Community" />
        <span>{label}</span>
        <AppIcon icon="NavArrowRight" className="managed-entity-bots-control__chevron" />
      </button>
      {loading ? (
        <span className="managed-entity-bots-control__status" role="status">
          Открываем ботов…
        </span>
      ) : null}
      {loadError ? (
        <span className="managed-entity-bots-control__status" role="alert">
          Не удалось открыть. Нажмите ещё раз.
        </span>
      ) : null}
      {open && Sheet ? (
        <Sheet
          {...props}
          id={dialogId}
          returnFocusRef={triggerRef}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

export default function ManagedEntityBotsControl(props: ManagedEntityBotsControlProps) {
  return (
    <BotsControl
      key={JSON.stringify([props.userId, props.entityType, props.entityId])}
      {...props}
    />
  );
}
